import type { ProxyModel } from '@repo/database';
import { normalizeKind } from '../telegram/proxy-transport.service.js';

export interface ProxyView {
  id: string;
  name: string;
  kind: string;
  host: string;
  port: number;
  username: string | null;
  hasSecret: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProxyTestResult {
  ok: boolean;
  latencyMs: number;
}

/**
 * Result of a real exit-node probe: an HTTP request through the proxy to an IP
 * echo service. `exitIp` is the address the outside world sees.
 */
export interface ProxyCheckResult {
  ok: boolean;
  latencyMs: number;
  exitIp?: string;
  country?: string;
  /** `mtproto` proxies cannot tunnel plain HTTP(S). */
  unsupported?: boolean;
  error?: string;
  checkedAt: string;
}

export function serializeProxy(proxy: ProxyModel): ProxyView {
  return {
    id: proxy.id,
    name: proxy.name,
    kind: normalizeKind(proxy.kind),
    host: proxy.host,
    port: proxy.port,
    username: proxy.username,
    hasSecret: proxy.secretEncrypted !== null,
    enabled: proxy.enabled,
    createdAt: proxy.createdAt.toISOString(),
    updatedAt: proxy.updatedAt.toISOString(),
  };
}
