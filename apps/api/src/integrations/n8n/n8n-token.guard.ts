import { Injectable, Logger } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import { apiError } from '../../common/api-error.js';

/** Header n8n sends on every Action API call. */
export const N8N_TOKEN_HEADER = 'x-combain-token';

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Compares two secrets without leaking their length or content through timing:
 * both sides are hashed first, so `timingSafeEqual` always sees 32 bytes.
 */
export function constantTimeEquals(provided: string, expected: string): boolean {
  return timingSafeEqual(digest(provided), digest(expected));
}

/**
 * Guards `/integrations/n8n/*` with a shared secret from `N8N_ACTION_TOKEN`.
 *
 * The endpoint is never left open: when the env var is unset every request is
 * answered with `503 N8N_DISABLED` (and a warning is logged once at start).
 */
@Injectable()
export class N8nTokenGuard implements CanActivate {
  private readonly logger = new Logger(N8nTokenGuard.name);
  private warned = false;

  constructor(private readonly config: ConfigService) {
    // Fail closed at boot as well: the endpoints answer 503 until the secret
    // is configured, so an unset env can never expose an open Action API.
    if (!this.expectedToken()) {
      this.warned = true;
      this.logger.warn(
        'N8N_ACTION_TOKEN is not set: the n8n Action API is disabled (all requests get 503)',
      );
    }
  }

  canActivate(context: ExecutionContext): boolean {
    const expected = this.expectedToken();
    if (!expected) {
      if (!this.warned) {
        this.warned = true;
        this.logger.warn(
          'N8N_ACTION_TOKEN is not set: the n8n Action API is disabled (all requests get 503)',
        );
      }
      throw apiError(
        'N8N_DISABLED',
        'N8N_ACTION_TOKEN is not configured on this server, so the n8n Action API is disabled',
        503,
      );
    }

    const request = context.switchToHttp().getRequest<{
      headers?: Record<string, unknown>;
    }>();
    if (!this.headerAllowed(request.headers, expected)) {
      throw apiError(
        'UNAUTHORIZED',
        `Missing or invalid ${N8N_TOKEN_HEADER} header`,
        401,
      );
    }
    return true;
  }

  private headerAllowed(
    headers: Record<string, unknown> | undefined,
    expected: string,
  ): boolean {
    if (!headers) return false;
    const raw = headers[N8N_TOKEN_HEADER] ?? headers[N8N_TOKEN_HEADER.toUpperCase()];
    const provided = Array.isArray(raw) ? raw[0] : raw;
    if (typeof provided !== 'string' || provided.length === 0) return false;
    return constantTimeEquals(provided, expected);
  }

  /** Read on every request so a restart-free secret rotation stays possible. */
  private expectedToken(): string {
    const fromConfig = this.config?.get<string>('N8N_ACTION_TOKEN');
    const value = (fromConfig ?? process.env.N8N_ACTION_TOKEN ?? '').trim();
    return value;
  }
}
