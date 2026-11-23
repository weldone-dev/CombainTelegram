import { Injectable } from '@nestjs/common';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Buffer } from 'node:buffer';
import { ProxyAgent, fetch } from 'undici';
import { SocksProxyAgent } from 'socks-proxy-agent';
import type { ProxyKind } from '../telegram/proxy-transport.service.js';

/** IP echo endpoints, tried in order. Both answer with the exit node IP. */
export const PROXY_ECHO_URLS = [
  'https://api.ipify.org?format=json',
  'https://icanhazip.com',
] as const;

export const PROXY_PROBE_TIMEOUT_MS = 10_000;

export interface ProxyProbeTarget {
  kind: ProxyKind;
  host: string;
  port: number;
  username: string | null;
  secret: string | null;
}

export interface ProxyProbeOutcome {
  exitIp?: string;
  country?: string;
}

/**
 * Makes a real HTTP(S) request through a stored proxy and reads the IP echo
 * answer. The address in the answer is the proxy's exit node, not the proxy
 * host itself. The target's secret is used only to build the connection and is
 * never logged or returned.
 */
@Injectable()
export class ProxyProbeService {
  async probe(target: ProxyProbeTarget): Promise<ProxyProbeOutcome> {
    const socks = target.kind === 'socks4' || target.kind === 'socks5';
    let lastError: unknown = null;

    for (const echoUrl of PROXY_ECHO_URLS) {
      try {
        const body = socks
          ? await this.requestViaSocks(echoUrl, target)
          : await this.requestViaHttpProxy(echoUrl, target);
        const parsed = parseEchoResponse(body);
        if (parsed.exitIp) return parsed;
        lastError = new Error('The IP echo did not return an IP address');
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error('The exit-node probe failed');
  }

  private async requestViaSocks(
    echoUrl: string,
    target: ProxyProbeTarget,
  ): Promise<string> {
    const agent = new SocksProxyAgent(this.proxyUrl(target));
    try {
      return await this.requestText(echoUrl, agent);
    } finally {
      agent.destroy();
    }
  }

  private async requestViaHttpProxy(
    echoUrl: string,
    target: ProxyProbeTarget,
  ): Promise<string> {
    const token = this.basicToken(target);
    const dispatcher = new ProxyAgent({
      uri: `${target.kind === 'https' ? 'https' : 'http'}://${formatHost(
        target.host,
      )}:${target.port}`,
      ...(token ? { token } : {}),
    });
    try {
      const response = await fetch(echoUrl, {
        dispatcher,
        signal: AbortSignal.timeout(PROXY_PROBE_TIMEOUT_MS),
        headers: { accept: 'application/json, text/plain' },
      });
      if (!response.ok) {
        throw new Error(`The IP echo answered HTTP ${response.status}`);
      }
      return await response.text();
    } finally {
      await dispatcher.close().catch(() => undefined);
    }
  }

  /** Node-side request; used because SocksProxyAgent is an `http.Agent`. */
  private requestText(url: string, agent: SocksProxyAgent): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const request = httpsRequest(
        url,
        {
          agent,
          timeout: PROXY_PROBE_TIMEOUT_MS,
          headers: { accept: 'application/json, text/plain' },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            const status = response.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              reject(new Error(`The IP echo answered HTTP ${status}`));
              return;
            }
            resolve(Buffer.concat(chunks).toString('utf8'));
          });
          response.on('error', reject);
        },
      );
      request.on('timeout', () => {
        request.destroy(new Error('The IP echo timed out'));
      });
      request.on('error', reject);
      request.end();
    });
  }

  private proxyUrl(target: ProxyProbeTarget): string {
    const kind = target.kind === 'socks4' ? 'socks4' : 'socks5';
    const credentials = target.username
      ? `${encodeURIComponent(target.username)}${
          target.secret ? `:${encodeURIComponent(target.secret)}` : ''
        }@`
      : '';
    return `${kind}://${credentials}${formatHost(target.host)}:${target.port}`;
  }

  private basicToken(target: ProxyProbeTarget): string | undefined {
    if (!target.username) return undefined;
    const value = `${target.username}:${target.secret ?? ''}`;
    return `Basic ${Buffer.from(value, 'utf8').toString('base64')}`;
  }
}

/**
 * Reads an IP echo answer: JSON (`{"ip":"…","country":"…"}`) or plain text.
 * Anything that is not an IP is ignored, so a captive-portal HTML page does not
 * look like a successful check.
 */
export function parseEchoResponse(body: string): ProxyProbeOutcome {
  const text = body.trim();
  if (!text) return {};

  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const ip =
        typeof record.ip === 'string' && isIP(record.ip.trim()) !== 0
          ? record.ip.trim()
          : undefined;
      const country =
        typeof record.country === 'string' && record.country.trim()
          ? record.country.trim().toUpperCase()
          : undefined;
      return { ...(ip ? { exitIp: ip } : {}), ...(country ? { country } : {}) };
    }
  } catch {
    // Plain-text echo endpoints (icanhazip) land here.
  }

  return isIP(text) !== 0 ? { exitIp: text } : {};
}

function formatHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}
