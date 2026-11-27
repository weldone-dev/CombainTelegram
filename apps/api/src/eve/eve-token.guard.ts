import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  eveTokenEnabled,
  eveTokenFromHeaders,
  eveTokenMatches,
} from './eve-token.js';

/**
 * Guards `/internal/eve/*`.
 *
 * The Eve process is local, so the token is deliberately simple: one shared
 * secret, compared in constant time. An empty EVE_TOKEN disables the whole
 * surface with 503 instead of leaving it open.
 */
@Injectable()
export class EveTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (!eveTokenEnabled()) {
      throw new ServiceUnavailableException({
        code: 'EVE_DISABLED',
        error: 'EVE_DISABLED',
        message: 'EVE_TOKEN is not configured',
      });
    }
    const request = context.switchToHttp().getRequest<Request>();
    const given = eveTokenFromHeaders(
      request.headers.authorization,
      typeof request.headers['x-eve-token'] === 'string'
        ? request.headers['x-eve-token']
        : undefined,
    );
    if (!eveTokenMatches(given)) {
      throw new UnauthorizedException({
        code: 'EVE_UNAUTHORIZED',
        error: 'EVE_UNAUTHORIZED',
        message: 'Invalid or missing Eve token',
      });
    }
    return true;
  }
}
