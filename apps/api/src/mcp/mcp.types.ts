import { timingSafeEqual } from 'node:crypto';

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

export function rpcError(id: unknown, error: JsonRpcError) {
  return { jsonrpc: '2.0', id: id ?? null, error };
}

/** Constant-time bearer token comparison. */
export function tokenMatches(expected: string, header: string | undefined): boolean {
  if (!header) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  const actual = Buffer.from(match[1] ?? '', 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  if (actual.length !== wanted.length) return false;
  return timingSafeEqual(actual, wanted);
}

export function mcpTools(list: Array<{
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}>) {
  return list.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters,
  }));
}

export function toolContent(result: unknown, isError = false) {
  return {
    content: [
      {
        type: 'text',
        text:
          typeof result === 'string'
            ? result
            : JSON.stringify(result, null, 2) ?? 'null',
      },
    ],
    ...(isError ? { isError: true } : {}),
  };
}
