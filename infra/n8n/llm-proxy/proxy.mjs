#!/usr/bin/env node
/**
 * Tiny OpenAI-compatible proxy in front of OpenCode Go.
 *
 * Why it exists: OpenCode Go rejects every request that does not carry a
 * stable `x-opencode-session` header. n8n's Assistant model dialog can only
 * set Base URL / API key / model - no custom headers. So n8n talks to this
 * proxy, the proxy adds the header (and the real key) and forwards upstream.
 *
 *   n8n Assistant --(OpenAI API)--> llm-proxy --(OpenAI API + headers)--> OpenCode Go
 *
 * Dependencies: none (node:http + built-in fetch + node:sqlite). Node 22+.
 *
 * Env:
 *   PORT                listen port, default 4000
 *   OPENCODE_BASE_URL   default https://opencode.ai/inference/go/openai/v1
 *   OPENCODE_API_KEY    OpenCode Go token - FALLBACK only (see below)
 *   OPENCODE_SESSION    default combain-n8n (the header OpenCode Go requires)
 *   OPENCODE_DB_PATH    default /data/opencode/opencode.db
 *
 * Token: the opencode CLI stores an OAuth access token in its SQLite DB and
 * refreshes it there. If OPENCODE_DB_PATH exists, the proxy re-reads
 * `credential.access` every 60 s, so a CLI re-login does not need a restart.
 * Missing/unreadable DB or empty row -> OPENCODE_API_KEY from env. The value
 * is never logged.
 *
 * Requests may use /models or /v1/models: a leading /v1 is stripped when the
 * base URL already ends in /v1, so n8n can be configured with ".../v1".
 */
import http from 'node:http';
import { existsSync } from 'node:fs';
import { pipeline, Readable } from 'node:stream';

const PORT = Number(process.env.PORT ?? 4000);
const BASE_URL = (process.env.OPENCODE_BASE_URL ?? 'https://opencode.ai/inference/go/openai/v1').replace(/\/+$/, '');
const ENV_KEY = (process.env.OPENCODE_API_KEY ?? '').trim();
const SESSION = (process.env.OPENCODE_SESSION ?? 'combain-n8n').trim() || 'combain-n8n';
const DB_PATH = process.env.OPENCODE_DB_PATH || '/data/opencode/opencode.db';
const KEY_TTL_MS = 60_000;

const MAX_BODY_BYTES = 32 * 1024 * 1024; // 32 MB
const TIMEOUT_MS = 10 * 60 * 1000; // 10 min, generous for long completions
const USER_AGENT = 'combain-n8n/1.0';

// node:sqlite is available from Node 22.5 (flag-free from 22.13). Load it
// lazily so an older runtime still starts and simply uses the env key.
let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  DatabaseSync = null;
}

const KEY_SQL =
  "select value from credential where integration_id = 'opencode' and active = 1 order by time_updated desc limit 1";

let cachedKey = '';
let cachedAt = 0;
let dbWarned = false;
let dbOkLogged = false;

function readKeyFromDb() {
  if (!DatabaseSync) throw new Error('node:sqlite unavailable');
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    const row = db.prepare(KEY_SQL).get();
    if (!row?.value) return '';
    const raw = typeof row.value === 'string' ? row.value : Buffer.from(row.value).toString('utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed?.access === 'string' ? parsed.access.trim() : '';
  } finally {
    db.close();
  }
}

/** Live key: opencode.db first (60 s cache), env as fallback. Never logged. */
function resolveKey() {
  const now = Date.now();
  if (cachedKey && now - cachedAt < KEY_TTL_MS) return cachedKey;

  let key = '';
  if (existsSync(DB_PATH)) {
    try {
      key = readKeyFromDb();
      if (key && !dbOkLogged) {
        dbOkLogged = true;
        console.log('[llm-proxy] token source: opencode.db (re-read every 60s)');
      }
    } catch (err) {
      if (!dbWarned) {
        dbWarned = true;
        console.error(
          `[llm-proxy] opencode.db unreadable (${err?.code ?? err?.name ?? 'error'}) - using OPENCODE_API_KEY from env`,
        );
      }
    }
  } else if (!dbWarned) {
    dbWarned = true;
    console.log('[llm-proxy] opencode.db not mounted - using OPENCODE_API_KEY from env');
  }

  cachedKey = key || ENV_KEY;
  cachedAt = now;
  return cachedKey;
}

if (!resolveKey()) {
  console.error('[llm-proxy] no token: set OPENCODE_API_KEY or mount the opencode DB - refusing to start');
  process.exit(1);
}

let base;
try {
  base = new URL(BASE_URL);
} catch {
  console.error('[llm-proxy] OPENCODE_BASE_URL is not a valid URL');
  process.exit(1);
}
const BASE_PATH = base.pathname.replace(/\/+$/, '');

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'access-control-allow-headers':
    'authorization,content-type,accept,x-api-key,api-key,openai-organization,openai-project,x-opencode-session,user-agent',
  'access-control-expose-headers': 'content-type,content-length,x-request-id,openai-processing-ms',
  'access-control-max-age': '86400',
};

// Never forwarded: hop-by-hop, client auth, browser-only and things fetch sets itself.
const DROP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'accept-encoding',
  'authorization',
  'x-opencode-session',
  'user-agent',
  'origin',
  'referer',
]);

const DROP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-encoding',
  'content-length',
]);

function targetUrl(rawUrl) {
  const q = rawUrl.indexOf('?');
  let path = q === -1 ? rawUrl : rawUrl.slice(0, q);
  const search = q === -1 ? '' : rawUrl.slice(q);
  if (!path.startsWith('/')) path = `/${path}`;
  // Accept both ".../v1" (base URL as typed in n8n) and bare paths (curl).
  if (BASE_PATH.endsWith('/v1')) {
    if (path === '/v1') path = '/';
    else if (path.startsWith('/v1/')) path = path.slice('/v1'.length);
  }
  return `${BASE_URL}${path}${search}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        const err = new Error('request body exceeds 32 MB');
        err.statusCode = 413;
        reject(err);
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  if (res.headersSent) {
    res.end();
    return;
  }
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...CORS_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const startedAt = Date.now();
  const method = req.method ?? 'GET';
  const path = (req.url ?? '/').split('?')[0];
  let status = 0;
  let logged = false;

  const finish = (finalStatus) => {
    if (logged) return;
    logged = true;
    console.log(`[llm-proxy] ${method} ${path} -> ${finalStatus ?? status ?? res.statusCode} ${Date.now() - startedAt}ms`);
  };
  res.on('finish', () => finish());
  res.on('close', () => {
    if (!res.writableFinished) finish(status || 499);
  });

  if (method === 'OPTIONS') {
    status = 204;
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  if (path === '/healthz' && (method === 'GET' || method === 'HEAD')) {
    status = 200;
    sendJson(res, 200, { ok: true });
    return;
  }

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error('upstream timeout after 10 min')), TIMEOUT_MS);
  res.on('close', () => {
    if (!res.writableFinished) abort.abort();
  });

  try {
    const hasBody = method !== 'GET' && method !== 'HEAD' && method !== 'DELETE';
    const body = hasBody ? await readBody(req) : undefined;

    const headers = { authorization: `Bearer ${resolveKey()}`, 'x-opencode-session': SESSION, 'user-agent': USER_AGENT };
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || DROP_REQUEST_HEADERS.has(name)) continue;
      headers[name] = Array.isArray(value) ? value.join(', ') : value;
    }
    if (hasBody && !headers['content-type']) headers['content-type'] = 'application/json';

    const upstream = await fetch(targetUrl(req.url ?? '/'), {
      method,
      headers,
      body,
      redirect: 'manual',
      signal: abort.signal,
    });

    status = upstream.status;
    const responseHeaders = { ...CORS_HEADERS };
    upstream.headers.forEach((value, name) => {
      if (DROP_RESPONSE_HEADERS.has(name)) return;
      responseHeaders[name] = value;
    });

    res.writeHead(upstream.status, responseHeaders);

    if (!upstream.body || method === 'HEAD') {
      res.end();
      return;
    }

    // Stream straight through: SSE deltas must reach the client as they arrive.
    pipeline(Readable.fromWeb(upstream.body), res, (err) => {
      if (err) console.error(`[llm-proxy] ${method} ${path} stream error: ${err.message}`);
    });
  } catch (err) {
    if (res.writableEnded || res.destroyed) return;
    const tooLarge = err?.statusCode === 413;
    status = tooLarge ? 413 : 502;
    const message = err?.name === 'AbortError' || abort.signal.aborted ? 'upstream timeout or client aborted' : err?.message;
    sendJson(res, status, { error: { message: `llm-proxy: ${message}`, type: 'proxy_error' } });
  } finally {
    clearTimeout(timer);
  }
});

server.requestTimeout = 0; // long SSE streams; the fetch timeout above governs upstream
server.headersTimeout = 60_000;
server.keepAliveTimeout = 75_000;

server.listen(PORT, '0.0.0.0', () => {
  // No key, no session value in the logs - only that the header is injected.
  console.log(`[llm-proxy] listening on :${PORT} -> ${BASE_URL} (x-opencode-session enabled)`);
});
