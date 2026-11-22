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
