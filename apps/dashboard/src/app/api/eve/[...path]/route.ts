import type { NextRequest } from "next/server";

/**
 * Server-side proxy for the internal Eve contract.
 *
 * `EVE_TOKEN` stays in the Next.js server process: the browser calls
 * `/api/eve/*`, this handler adds `x-eve-token` and forwards the request to
 * Nest's `/internal/eve/*`. Only the dashboard's own persona/allowlist/state
 * endpoints are reachable — the rest of the internal surface (messages,
 * presence, memory writes) is deliberately not proxied.
 */

const NEST_URL = (
  process.env.EVE_NEST_URL ||
  process.env.API_URL ||
  process.env.NEXT_PUBLIC_API_URL ||
  "http://127.0.0.1:4001"
).replace(/\/+$/, "");

const ID = "[A-Za-z0-9_-]+";

const ROUTES: Array<{ method: string; pattern: RegExp }> = [
  { method: "GET", pattern: /^personas$/ },
  { method: "POST", pattern: /^personas$/ },
  { method: "GET", pattern: new RegExp(`^personas/${ID}$`) },
  { method: "PATCH", pattern: new RegExp(`^personas/${ID}$`) },
  { method: "POST", pattern: new RegExp(`^personas/${ID}/accounts$`) },
  { method: "DELETE", pattern: new RegExp(`^personas/${ID}/accounts/${ID}$`) },
  { method: "GET", pattern: new RegExp(`^personas/${ID}/chats$`) },
  { method: "POST", pattern: new RegExp(`^personas/${ID}/chats$`) },
  // Persona documents (persona/speech/boundaries/communication) and the
  // deterministic generator. The browser cannot write arbitrary files.
  { method: "GET", pattern: new RegExp(`^personas/${ID}/docs$`) },
  { method: "PUT", pattern: new RegExp(`^personas/${ID}/docs$`) },
  { method: "POST", pattern: new RegExp(`^personas/${ID}/generate$`) },
  // Read-only memory surface: daily summaries, facts, palace drawers, agenda
  // and the raw session log. No capture/recall writes are exposed.
  { method: "GET", pattern: /^memory\/daily$/ },
  { method: "GET", pattern: /^memory\/facts$/ },
  { method: "GET", pattern: /^memory\/palace$/ },
  { method: "GET", pattern: /^memory\/sessions$/ },
  { method: "GET", pattern: /^agenda$/ },
  // Context snapshots: exactly what was sent to the model on a turn. The list
  // is newest-first; the detail route is used when a summary lacks full text.
  { method: "GET", pattern: /^context\/snapshots$/ },
  { method: "GET", pattern: new RegExp(`^context/snapshots/${ID}$`) },
  // Durable deferred-action queue (delayed turns, edits, deletes, reactions).
  // Read-only: enqueueing and dispatching stay with the Eve channel and Nest's
  // 60-second tick.
  { method: "GET", pattern: /^actions$/ },
  // Schedules: compiled Eve schedules (from /eve/v1/info) plus the durable
  // delayed queue and its counts. Read-only.
  { method: "GET", pattern: /^schedules$/ },
  { method: "GET", pattern: /^state\/relationship$/ },
  { method: "GET", pattern: /^state\/conflict$/ },
  // Chat timeline («Хроника»): messages, ignores and relationship deltas.
  { method: "GET", pattern: /^timeline$/ },
];

function json(status: number, code: string, message: string): Response {
  return Response.json({ code, message }, { status });
}

function isAllowed(method: string, path: string): boolean {
  return ROUTES.some(
    (route) => route.method === method && route.pattern.test(path),
  );
}

async function proxy(request: NextRequest, segments: string[]) {
  const path = segments.join("/");
  if (
    segments.length === 0 ||
    segments.some((segment) => !/^[A-Za-z0-9_-]+$/.test(segment)) ||
    !isAllowed(request.method, path)
  ) {
    return json(
      404,
      "EVE_PROXY_NOT_FOUND",
      `Eve endpoint ${request.method} /${path} is not exposed to the dashboard`,
    );
  }

  const token = (process.env.EVE_TOKEN ?? "").trim();
  if (!token) {
    return json(
      503,
      "EVE_PROXY_DISABLED",
      "EVE_TOKEN is not configured for the dashboard server",
    );
  }

  const body = ["POST", "PUT", "PATCH"].includes(request.method)
    ? await request.text()
    : "";

  const headers = new Headers({ "x-eve-token": token });
  if (body) headers.set("Content-Type", "application/json");

  let upstream: Response;
  try {
    upstream = await fetch(
      `${NEST_URL}/internal/eve/${path}${request.nextUrl.search}`,
      {
        method: request.method,
        headers,
        body: body || undefined,
        cache: "no-store",
        signal: request.signal,
      },
    );
  } catch (error) {
    console.error("Eve proxy request failed", error);
    return json(
      502,
      "EVE_PROXY_UNREACHABLE",
      "Nest API is unreachable from the dashboard server",
    );
  }

  const responseHeaders = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType) responseHeaders.set("Content-Type", contentType);

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  return proxy(request, path);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  return proxy(request, path);
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  return proxy(request, path);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  return proxy(request, path);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  return proxy(request, path);
}
