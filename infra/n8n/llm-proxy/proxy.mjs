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
 *   LLM_TRACE_DIR       JSONL dir for request/response bodies. Empty (default)
 *                       = no tracing at all, exactly the old behaviour.
 *   LLM_TRACE_KEEP_DAYS retention for trace files, default 7
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
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { existsSync, mkdirSync } from 'node:fs';
import { appendFile, readdir, unlink } from 'node:fs/promises';
import { pipeline, Readable, Transform } from 'node:stream';

const PORT = Number(process.env.PORT ?? 4000);
const BASE_URL = (process.env.OPENCODE_BASE_URL ?? 'https://opencode.ai/inference/go/openai/v1').replace(/\/+$/, '');
const ENV_KEY = (process.env.OPENCODE_API_KEY ?? '').trim();
const SESSION = (process.env.OPENCODE_SESSION ?? 'combain-n8n').trim() || 'combain-n8n';
const DB_PATH = process.env.OPENCODE_DB_PATH || '/data/opencode/opencode.db';
const KEY_TTL_MS = 60_000;

const MAX_BODY_BYTES = 32 * 1024 * 1024; // 32 MB
const TIMEOUT_MS = 10 * 60 * 1000; // 10 min, generous for long completions
const USER_AGENT = 'combain-n8n/1.0';

// --- request/response tracing (opt-in) --------------------------------------
// Bodies are written to ${LLM_TRACE_DIR}/YYYY-MM-DD.jsonl (UTC day), one JSON
// object per POST with a body. LLM_TRACE_DIR empty -> nothing is written and
// the proxy behaves exactly as before. Secrets (key, session header) are never
// part of a trace line: only an allowlist of harmless request headers is kept.
const TRACE_DIR = (process.env.LLM_TRACE_DIR ?? '').trim();
const TRACE_KEEP_DAYS = Math.max(1, Number.parseInt(process.env.LLM_TRACE_KEEP_DAYS ?? '', 10) || 7);
const TRACE_KEEP_MS = TRACE_KEEP_DAYS * 24 * 60 * 60 * 1000;
const TRACE_FIELD_BYTES = 200 * 1024; // one string field (one message)
const TRACE_MESSAGES_BYTES = 2 * 1024 * 1024; // whole messages array
const TRACE_RESPONSE_BYTES = 64 * 1024; // accumulated completion text
const TRACE_PARSE_BYTES = 2 * 1024 * 1024; // full non-stream JSON needed for usage
const TRACE_DAY_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

// Headers worth keeping for debugging (who called, what format). Everything
// else is dropped; credential headers are recorded as "[redacted]" only.
const TRACE_SAFE_HEADERS = new Set([
  'content-type',
  'accept',
  'user-agent',
  'openai-organization',
  'openai-project',
  'x-request-id',
]);
const TRACE_SECRET_HEADERS = new Set([
  'authorization',
  'api-key',
  'x-api-key',
  'cookie',
  'set-cookie',
  'x-opencode-session',
]);

let traceActive = false;
let traceWarned = false;
let traceWriteChain = Promise.resolve();

function traceWarn(what, err) {
  if (traceWarned) return;
  traceWarned = true;
  console.error(
    `[llm-proxy] trace ${what} failed (${err?.code ?? err?.name ?? 'error'}) - trace output may be incomplete`,
  );
}

function byteLength(text) {
  return Buffer.byteLength(text, 'utf8');
}

/** Cap a string to maxBytes of UTF-8, marking the cut. */
function capUtf8(text, maxBytes) {
  if (typeof text !== 'string' || byteLength(text) <= maxBytes) return { text, truncated: false };
  let slice = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
  slice = slice.replace(/\uFFFD+$/, ''); // a split multi-byte char at the edge
  return { text: `${slice}\n…__truncated (cap ${maxBytes} bytes)`, truncated: true };
}

/** Recursively cap every string in a parsed JSON value. */
function capDeep(value, maxBytes, depth = 0) {
  if (typeof value === 'string') {
    const { text, truncated } = capUtf8(value, maxBytes);
    return truncated ? text : value;
  }
  if (depth > 20) return '__truncated (depth)';
  if (Array.isArray(value)) return value.map((item) => capDeep(item, maxBytes, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = capDeep(item, maxBytes, depth + 1);
    return out;
  }
  return value;
}

/**
 * Trace copy of `messages`: per-message cap, then a collective cap that keeps
 * the leading system block and the newest turns, dropping the middle of a long
 * history with an explicit marker (the persona is what we trace for).
 */
function traceMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  const capped = messages.map((message) => capDeep(message, TRACE_FIELD_BYTES));
  if (byteLength(JSON.stringify(capped)) <= TRACE_MESSAGES_BYTES) return capped;

  // Keep the leading system block (the persona is the whole point of tracing)
  // plus as many of the NEWEST turns as fit; drop the middle of long histories.
  let head = 0;
  while (head < capped.length && capped[head]?.role === 'system') head += 1;
  const headPart = capped.slice(0, head);
  let total = byteLength(JSON.stringify(headPart));
  const tail = [];
  for (let i = capped.length - 1; i >= head; i -= 1) {
    const size = byteLength(JSON.stringify(capped[i])) + 1;
    if (total + size > TRACE_MESSAGES_BYTES) break;
    tail.unshift(capped[i]);
    total += size;
  }
  const dropped = capped.length - headPart.length - tail.length;
  if (dropped <= 0) return capped;
  return [
    ...headPart,
    {
      role: 'system',
      content: `__truncated: ${dropped} older message(s) dropped from this trace line (collective cap ${TRACE_MESSAGES_BYTES} bytes)`,
      __truncated: true,
      droppedMessages: dropped,
    },
    ...tail,
  ];
}

function traceHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase();
    if (TRACE_SECRET_HEADERS.has(lower)) {
      out[lower] = '[redacted]';
      continue;
    }
    if (!TRACE_SAFE_HEADERS.has(lower)) continue;
    out[lower] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

function contentToString(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part;
        if (typeof part?.text === 'string') return part.text;
        return '';
      })
      .join('');
  }
  if (value && typeof value === 'object' && typeof value.text === 'string') return value.text;
  return '';
}

function traceUpstreamPath(rawUrl) {
  try {
    const url = new URL(targetUrl(rawUrl));
    return `${url.pathname}${url.search}`;
  } catch {
    return undefined;
  }
}

/** Snapshot of the request side; response fields are added on completion. */
function buildTraceRequest({ id, method, path: reqPath, url, body, headers }) {
  let parsed = null;
  let parseError;
  if (body && body.length > 0) {
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch (err) {
      parseError = err?.message ?? 'invalid JSON';
    }
  }
  const sourceMessages = Array.isArray(parsed?.messages) ? parsed.messages : undefined;
  return {
    snapshot: {
      ts: new Date().toISOString(),
      id,
      method,
      path: reqPath,
      upstreamPath: traceUpstreamPath(url),
      model: typeof parsed?.model === 'string' ? parsed.model : undefined,
      stream: typeof parsed?.stream === 'boolean' ? parsed.stream : undefined,
      messageCount: sourceMessages ? sourceMessages.length : undefined,
      messages: sourceMessages ? traceMessages(sourceMessages) : undefined,
      tools: parsed?.tools ? capDeep(parsed.tools, TRACE_FIELD_BYTES) : undefined,
      max_tokens: parsed?.max_tokens ?? parsed?.max_completion_tokens ?? undefined,
      temperature: parsed?.temperature ?? undefined,
      headers: traceHeaders(headers),
      parseError,
    },
  };
}

/** Non-stream response: keep up to TRACE_PARSE_BYTES to read usage, then cap text. */
function createBodyCapture(limitBytes) {
  const chunks = [];
  let size = 0;
  let truncated = false;
  return {
    push(chunk) {
      if (size >= limitBytes) {
        truncated = true;
        return;
      }
      const room = limitBytes - size;
      if (chunk.length > room) {
        chunks.push(Buffer.from(chunk.subarray(0, room)));
        size = limitBytes;
        truncated = true;
        return;
      }
      chunks.push(Buffer.from(chunk));
      size += chunk.length;
    },
    finish() {
      const raw = Buffer.concat(chunks).toString('utf8');
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      if (!parsed) {
        const { text } = capUtf8(raw, TRACE_RESPONSE_BYTES);
        return {
          text: text || undefined,
          textTruncated: truncated || undefined,
          parseError: truncated ? 'response exceeded trace capture limit' : 'response is not JSON',
        };
      }
      const choice = parsed.choices?.[0];
      const content = contentToString(choice?.message?.content) || contentToString(choice?.text);
      const { text, truncated: textTruncated } = capUtf8(content, TRACE_RESPONSE_BYTES);
      let fallback = '';
      if (!content && parsed.error !== undefined) {
        fallback = typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error);
      }
      const { text: fallbackText } = capUtf8(fallback, TRACE_RESPONSE_BYTES);
      return {
        text: content ? text : fallbackText || undefined,
        textTruncated: textTruncated || undefined,
        usage: parsed.usage ?? undefined,
        finishReason: choice?.finish_reason ?? undefined,
        responseTruncated: truncated || undefined,
      };
    },
  };
}

/** SSE response: accumulate delta.content only (bounded), plus usage/finish. */
function createSseCapture() {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let text = '';
  let textBytes = 0;
  let textTruncated = false;
  let usage = null;
  let finishReason = null;
  let events = 0;
  let parseErrors = 0;

  function appendContent(piece) {
    if (typeof piece !== 'string' || piece.length === 0) return;
    const size = byteLength(piece);
    if (textBytes + size > TRACE_RESPONSE_BYTES) {
      textTruncated = true;
      const room = TRACE_RESPONSE_BYTES - textBytes;
      if (room > 0) {
        const { text: part } = capUtf8(piece, room);
        text += part;
        textBytes = TRACE_RESPONSE_BYTES;
      }
      return;
    }
    text += piece;
    textBytes += size;
  }

  function handleLine(line) {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    events += 1;
    let obj;
    try {
      obj = JSON.parse(payload);
    } catch {
      parseErrors += 1;
      return;
    }
    const choice = obj?.choices?.[0];
    const piece = choice?.delta?.content ?? choice?.message?.content;
    if (typeof piece === 'string') appendContent(piece);
    else if (piece && typeof piece === 'object') appendContent(contentToString(piece));
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (obj?.usage) usage = obj.usage;
  }

  return {
    push(chunk) {
      buffer += decoder.write(chunk);
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        handleLine(buffer.slice(0, index).replace(/\r$/, ''));
        buffer = buffer.slice(index + 1);
      }
    },
    finish() {
      buffer += decoder.end();
      if (buffer.trim()) handleLine(buffer.trim());
      return {
        text: text || undefined,
        textTruncated: textTruncated || undefined,
        usage: usage ?? undefined,
        finishReason: finishReason ?? undefined,
        events,
        parseErrors: parseErrors || undefined,
      };
    },
  };
}

/** Append one line, serialized so big lines never interleave. Never throws. */
function writeTrace(entry) {
  if (!traceActive) return;
  let line;
  try {
    line = `${JSON.stringify(entry)}\n`;
  } catch (err) {
    traceWarn('serialization', err);
    return;
  }
  const file = path.join(TRACE_DIR, `${(entry.ts ?? '').slice(0, 10)}.jsonl`);
  traceWriteChain = traceWriteChain
    .then(() => appendFile(file, line))
    .catch((err) => traceWarn('write', err));
}

/** Delete trace files older than LLM_TRACE_KEEP_DAYS (by date in the name). */
async function rotateTraces() {
  if (!traceActive) return;
  try {
    const cutoff = Date.now() - TRACE_KEEP_MS;
    for (const name of await readdir(TRACE_DIR)) {
      const match = TRACE_DAY_RE.exec(name);
      if (!match) continue;
      const day = Date.parse(`${match[1]}T00:00:00Z`);
      if (Number.isFinite(day) && day < cutoff) {
        await unlink(path.join(TRACE_DIR, name)).catch(() => {});
      }
    }
  } catch (err) {
    traceWarn('rotation', err);
  }
}

if (TRACE_DIR) {
  try {
    mkdirSync(TRACE_DIR, { recursive: true });
    traceActive = true;
    console.log(`[llm-proxy] tracing bodies to ${TRACE_DIR} (keep ${TRACE_KEEP_DAYS}d, JSONL by UTC day)`);
    void rotateTraces();
    setInterval(() => void rotateTraces(), 24 * 60 * 60 * 1000).unref();
  } catch (err) {
    traceWarn('directory', err);
  }
}

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

  let traceReq = null;

  try {
    const hasBody = method !== 'GET' && method !== 'HEAD' && method !== 'DELETE';
    const body = hasBody ? await readBody(req) : undefined;

    // Trace copy is built before the upstream call; response is appended later.
    traceReq =
      traceActive && method === 'POST'
        ? buildTraceRequest({
            id: randomUUID(),
            method,
            path,
            url: req.url ?? '/',
            body,
            headers: req.headers,
          })
        : null;

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
      if (traceReq) writeTrace({ ...traceReq.snapshot, response: { status }, durationMs: Date.now() - startedAt });
      return;
    }

    // Tap the body on the way through (bounded); the client still gets every
    // byte immediately, and a trace failure can never break the response.
    const contentType = (upstream.headers.get('content-type') ?? '').toLowerCase();
    const wantsStream = traceReq?.snapshot.stream === true;
    const isSse = contentType.includes('text/event-stream') || (wantsStream && !contentType.includes('application/json'));
    const capture = traceReq ? (isSse ? createSseCapture() : createBodyCapture(TRACE_PARSE_BYTES)) : null;

    // Stream straight through: SSE deltas must reach the client as they arrive.
    // The Transform only observes chunks; it never delays or reorders them.
    const tap = new Transform({
      transform(chunk, _encoding, callback) {
        if (capture) {
          try {
            capture.push(chunk);
          } catch (err) {
            traceWarn('capture', err);
          }
        }
        callback(null, chunk);
      },
    });
    pipeline(Readable.fromWeb(upstream.body), tap, res, (err) => {
      if (err) console.error(`[llm-proxy] ${method} ${path} stream error: ${err.message}`);
      if (traceReq) {
        let response = { status };
        if (capture) {
          try {
            const captured = capture.finish() ?? {};
            response = { status };
            for (const key of ['text', 'textTruncated', 'usage', 'finishReason', 'events', 'parseErrors', 'parseError', 'responseTruncated']) {
              if (captured[key] !== undefined) response[key] = captured[key];
            }
          } catch (captureErr) {
            response.captureError = captureErr?.message ?? 'capture failed';
          }
        }
        if (err) response.error = capUtf8(`stream error: ${err.message}`, 2048).text;
        writeTrace({ ...traceReq.snapshot, response, durationMs: Date.now() - startedAt });
      }
    });
  } catch (err) {
    const tooLarge = err?.statusCode === 413;
    status = tooLarge ? 413 : 502;
    const message = err?.name === 'AbortError' || abort.signal.aborted ? 'upstream timeout or client aborted' : err?.message;
    if (traceReq) {
      writeTrace({
        ...traceReq.snapshot,
        response: { status, error: capUtf8(`llm-proxy: ${message}`, 2048).text },
        durationMs: Date.now() - startedAt,
      });
    }
    if (res.writableEnded || res.destroyed) return;
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
