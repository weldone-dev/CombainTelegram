import { Injectable, Logger } from '@nestjs/common';
import type { AiSettingModel } from '@repo/database';
import { Agent, fetch as httpFetch } from 'undici';
import type { RequestInit as UndiciRequestInit, Response } from 'undici';
import { isPrivateHost } from '../ai/speech.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SessionCryptoService } from '../telegram/session-crypto.service.js';
import type {
  N8nConnection,
  N8nExecutionSummary,
  N8nExecutionsResult,
  N8nTestResult,
  N8nWorkflowSummary,
  N8nWorkflowsResult,
} from './workflows.types.js';

const SETTINGS_ID = 'default';
/** AAD of the sealed n8n API key, matching the provider-key envelope. */
const N8N_KEY_AAD = 'ai:n8n-key';
/** Sealed values carry this prefix; plain legacy values still work. */
const SECRET_PREFIX = 'enc:v1:';
/** Local n8n docker-compose default (`infra/n8n`). */
const DEFAULT_BASE_URL = 'http://127.0.0.1:5678';
/** The dashboard waits for these calls, so they must not hang it. */
const TIMEOUT_MS = 8_000;
const MAX_ERROR = 300;
/** Default page size of the n8n list endpoints. */
const LIST_LIMIT = 100;
const DEFAULT_EXECUTION_LIMIT = 10;
const MAX_EXECUTION_LIMIT = 100;

let directAgent: Agent | null = null;

/**
 * Proxy-free dispatcher for loopback/LAN n8n. The workstation sets
 * `HTTP(S)_PROXY` to a corporate proxy that answers 503 for the LAN, so a local
 * n8n must bypass it explicitly (same rule as the STT calls).
 */
function directDispatcher(): Agent {
  directAgent ??= new Agent({ connect: { timeout: 10_000 } });
  return directAgent;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Prisma/n8n ids are strings, but JSON may carry numbers. */
function idOf(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/**
 * `<base>/api/v1`, tolerating a trailing slash and a base that already ends
 * with the API path.
 */
export function n8nApiBase(baseUrl: string): string {
  const base = text(baseUrl).replace(/\/+$/, '') || DEFAULT_BASE_URL;
  return base.endsWith('/api/v1') ? base : `${base}/api/v1`;
}

/** Requests: `GET <api>/workflows?limit=100`, no redirect loops. */
export function n8nWorkflowsUrl(baseUrl: string, limit = LIST_LIMIT): string {
  return `${n8nApiBase(baseUrl)}/workflows?limit=${limit}`;
}

export function n8nExecutionsUrl(
  baseUrl: string,
  workflowId: string,
  limit = DEFAULT_EXECUTION_LIMIT,
): string {
  const capped = Math.min(MAX_EXECUTION_LIMIT, Math.max(1, limit));
  return `${n8nApiBase(baseUrl)}/executions?workflowId=${encodeURIComponent(
    workflowId,
  )}&limit=${capped}`;
}

function clampLimit(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return DEFAULT_EXECUTION_LIMIT;
  return Math.min(
    MAX_EXECUTION_LIMIT,
    Math.max(1, Math.round(number)),
  );
}

/** `{ data: [...] }` (n8n v1) or a bare array. */
function payloadItems(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    const data = (parsed as { data?: unknown }).data;
    if (Array.isArray(data)) return data;
  }
  return null;
}

function isoString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value instanceof Date) return value.toISOString();
  return null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

export function mapN8nWorkflow(item: unknown): N8nWorkflowSummary | null {
  const row = record(item);
  const id = idOf(row.id);
  if (!id) return null;
  return {
    id,
    name: text(row.name) || id,
    active: row.active === true,
    updatedAt: isoString(row.updatedAt),
  };
}

export function mapN8nExecution(item: unknown): N8nExecutionSummary | null {
  const row = record(item);
  const id = idOf(row.id);
  if (!id) return null;
  const explicit = text(row.status);
  const status =
    explicit ||
    (row.finished === true
      ? 'success'
      : row.finished === false
        ? 'running'
        : 'unknown');
  return {
    id,
    status,
    startedAt: isoString(row.startedAt),
    stoppedAt: isoString(row.stoppedAt),
    mode: text(row.mode) || null,
  };
}

/** First `code` of a fetch error cause (`ECONNREFUSED`, `ENOTFOUND`, ...). */
function causeCode(cause: unknown): string {
  if (!cause || typeof cause !== 'object') return '';
  const code = (cause as { code?: unknown }).code;
  if (typeof code === 'string' && code.trim()) return code.trim();
  const errors = (cause as { errors?: unknown }).errors;
  if (Array.isArray(errors)) {
    for (const inner of errors) {
      const value = causeCode(inner);
      if (value) return value;
    }
  }
  return '';
}

/** Short, single-line reason. The API key is scrubbed defensively. */
export function reasonOf(error: unknown, apiKey?: string | null): string {
  let raw = error instanceof Error ? error.message : String(error);
  if (error instanceof Error) {
    // Node's fetch hides the real cause behind "fetch failed".
    const code = causeCode((error as { cause?: unknown }).cause);
    if (code && !raw.includes(code)) raw = `${raw} (${code})`;
  }
  let value = raw;
  if (apiKey) value = value.split(apiKey).join('***');
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR);
}

/** Reason out of a non-2xx body: n8n's `{ message }`, else a text preview. */
export function responseError(raw: string, apiKey?: string | null): string {
  const trimmed = raw.trim();
  if (!trimmed) return 'n8n returned an empty answer';
  try {
    const parsed = JSON.parse(trimmed) as {
      message?: unknown;
      error?: { message?: unknown } | string;
    };
    if (typeof parsed.message === 'string') {
      return reasonOf(parsed.message, apiKey);
    }
    if (typeof parsed.error === 'string') return reasonOf(parsed.error, apiKey);
    if (typeof parsed.error?.message === 'string') {
      return reasonOf(parsed.error.message, apiKey);
    }
  } catch {
    // Plain text: preview it.
  }
  return reasonOf(trimmed, apiKey);
}

/**
 * Server-side n8n API proxy. The API key is read from `AiSetting.n8nApiKey`
 * (or `N8N_API_KEY`) and stays here: no endpoint of this module ever returns
 * it. Connection failures are reported as `{ ok: false, error }`, never thrown,
 * because the dashboard must keep working while n8n is down.
 */
@Injectable()
export class N8nClientService {
  private readonly logger = new Logger(N8nClientService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: SessionCryptoService,
  ) {}

  /**
   * Effective connection: the environment overrides the stored row; the key
   * follows the same order. A missing settings table (older database) still
   * yields the local default.
   */
  async connection(): Promise<N8nConnection> {
    const row = await this.settingsRow();
    const baseUrl = (
      text(process.env.N8N_BASE_URL) ||
      text(row?.n8nBaseUrl) ||
      DEFAULT_BASE_URL
    ).replace(/\/+$/, '');
    const apiKey = this.readKey(row) ?? text(process.env.N8N_API_KEY) ?? null;
    return { baseUrl: baseUrl || DEFAULT_BASE_URL, apiKey: apiKey || null };
  }

  /** `GET /api/v1/workflows?limit=100`; never throws. */
  async listWorkflows(): Promise<N8nWorkflowsResult> {
    let connection: N8nConnection;
    try {
      connection = await this.connection();
    } catch (error) {
      return {
        ok: false,
        workflows: [],
        error: reasonOf(error),
      };
    }

    try {
      const url = n8nWorkflowsUrl(connection.baseUrl);
      const { response, raw } = await this.get(url, connection.apiKey);
      if (!response.ok) {
        return {
          ok: false,
          workflows: [],
          error: `HTTP ${response.status}: ${responseError(raw, connection.apiKey)}`,
        };
      }
      const parsed = this.parseJson(raw);
      const items = payloadItems(parsed);
      if (!items) {
        return {
          ok: false,
          workflows: [],
          error: 'n8n returned an unexpected payload',
        };
      }
      const workflows = items
        .map((item) => mapN8nWorkflow(item))
        .filter((item): item is N8nWorkflowSummary => item !== null);
      return { ok: true, workflows };
    } catch (error) {
      return {
        ok: false,
        workflows: [],
        error: reasonOf(error, connection.apiKey),
      };
    }
  }

  /** `POST /workflows/n8n/test`: one minimal list call, with latency. */
  async test(): Promise<N8nTestResult> {
    const started = Date.now();
    let connection: N8nConnection;
    try {
      connection = await this.connection();
    } catch (error) {
      return {
        ok: false,
        status: null,
        latencyMs: 0,
        error: reasonOf(error),
      };
    }

    try {
      const { response, raw } = await this.get(
        n8nWorkflowsUrl(connection.baseUrl, 1),
        connection.apiKey,
      );
      const latencyMs = Date.now() - started;
      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          latencyMs,
          error: responseError(raw, connection.apiKey),
        };
      }
      return { ok: true, status: response.status, latencyMs };
    } catch (error) {
      return {
        ok: false,
        status: null,
        latencyMs: Date.now() - started,
        error: reasonOf(error, connection.apiKey),
      };
    }
  }

  /** Recent executions of one n8n workflow; never throws. */
  async executions(
    workflowId: string,
    limit: unknown = DEFAULT_EXECUTION_LIMIT,
  ): Promise<N8nExecutionsResult> {
    let connection: N8nConnection;
    try {
      connection = await this.connection();
    } catch (error) {
      return { ok: false, executions: [], error: reasonOf(error) };
    }

    try {
      const url = n8nExecutionsUrl(
        connection.baseUrl,
        workflowId,
        clampLimit(limit),
      );
      const { response, raw } = await this.get(url, connection.apiKey);
      if (!response.ok) {
        return {
          ok: false,
          executions: [],
          error: `HTTP ${response.status}: ${responseError(raw, connection.apiKey)}`,
        };
      }
      const items = payloadItems(this.parseJson(raw));
      if (!items) {
        return {
          ok: false,
          executions: [],
          error: 'n8n returned an unexpected payload',
        };
      }
      const executions = items
        .map((item) => mapN8nExecution(item))
        .filter((item): item is N8nExecutionSummary => item !== null);
      return { ok: true, executions };
    } catch (error) {
      return {
        ok: false,
        executions: [],
        error: reasonOf(error, connection.apiKey),
      };
    }
  }

  /** One GET with the `X-N8N-API-KEY` header and the LAN proxy bypass. */
  private async get(
    url: string,
    apiKey: string | null,
  ): Promise<{ response: Response; raw: string }> {
    const init: UndiciRequestInit = {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...(apiKey ? { 'X-N8N-API-KEY': apiKey } : {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    };
    try {
      if (isPrivateHost(new URL(url).hostname)) {
        init.dispatcher = directDispatcher();
      }
    } catch {
      // A malformed URL fails at fetch() with a readable error.
    }
    const response = await httpFetch(url, init);
    const raw = await response.text().catch(() => '');
    return { response, raw };
  }

  private parseJson(raw: string): unknown {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }

  private async settingsRow(): Promise<AiSettingModel | null> {
    try {
      return (await this.prisma.aiSetting.findUnique({
        where: { id: SETTINGS_ID },
      })) as AiSettingModel | null;
    } catch (error) {
      // A missing migration must not break the proxy: env/default apply.
      this.logger.warn(
        `n8n settings are unavailable: ${(error as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Stored key. Values written by this app are sealed as
   * `enc:v1:<base64 envelope>`; a hand-written plain value is used as-is, like
   * the provider and STT keys.
   */
  private readKey(row: AiSettingModel | null): string | null {
    const stored = row?.n8nApiKey?.trim();
    if (!stored) return null;
    if (!stored.startsWith(SECRET_PREFIX)) return stored;
    try {
      const envelope = new Uint8Array(
        Buffer.from(stored.slice(SECRET_PREFIX.length), 'base64'),
      );
      return this.crypto
        .decrypt(this.crypto.deserialize(envelope), N8N_KEY_AAD)
        .toString('utf8');
    } catch (error) {
      this.logger.warn(
        `Could not decrypt the n8n API key: ${(error as Error).message}`,
      );
      return null;
    }
  }
}
