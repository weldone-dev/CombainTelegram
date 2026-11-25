import { HttpException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { N8nTokenGuard, constantTimeEquals } from './n8n-token.guard.js';

function context(headers: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers }),
    }),
  } as unknown as ExecutionContext;
}

function config(): ConfigService {
  return {
    get: (key: string) => process.env[key],
  } as unknown as ConfigService;
}

function statusOf(run: () => unknown): number {
  try {
    run();
  } catch (error) {
    if (error instanceof HttpException) return error.getStatus();
    throw error;
  }
  throw new Error('expected the guard to throw');
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    const body = (error as HttpException).getResponse() as { code: string };
    return body.code;
  }
  throw new Error('expected the guard to throw');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('N8nTokenGuard', () => {
  it('refuses with 401 when the header is missing', () => {
    vi.stubEnv('N8N_ACTION_TOKEN', 'secret-token');
    const guard = new N8nTokenGuard(config());
    expect(statusOf(() => guard.canActivate(context({})))).toBe(401);
    expect(codeOf(() => guard.canActivate(context({})))).toBe('UNAUTHORIZED');
  });

  it('refuses with 401 when the token is wrong', () => {
    vi.stubEnv('N8N_ACTION_TOKEN', 'secret-token');
    const guard = new N8nTokenGuard(config());
    expect(
      statusOf(() =>
        guard.canActivate(context({ 'x-combain-token': 'nope' })),
      ),
    ).toBe(401);
  });

  it('accepts the configured token', () => {
    vi.stubEnv('N8N_ACTION_TOKEN', 'secret-token');
    const guard = new N8nTokenGuard(config());
    expect(
      guard.canActivate(context({ 'x-combain-token': 'secret-token' })),
    ).toBe(true);
  });

  it('keeps the endpoint closed when the env is unset', () => {
    vi.stubEnv('N8N_ACTION_TOKEN', '');
    const guard = new N8nTokenGuard(config());
    expect(
      statusOf(() => guard.canActivate(context({ 'x-combain-token': '' }))),
    ).toBe(503);
    expect(
      codeOf(() => guard.canActivate(context({ 'x-combain-token': '' }))),
    ).toBe('N8N_DISABLED');
  });

  it('compares secrets in constant time without length leaks', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true);
    expect(constantTimeEquals('abc', 'abcd')).toBe(false);
    expect(constantTimeEquals('', 'abc')).toBe(false);
  });
});
