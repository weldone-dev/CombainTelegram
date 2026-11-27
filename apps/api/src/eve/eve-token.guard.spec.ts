import type { ExecutionContext, HttpException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EveTokenGuard } from './eve-token.guard.js';

const TOKEN = 'test-eve-token';

function context(headers: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers }),
    }),
  } as unknown as ExecutionContext;
}

function responseOf(run: () => void): { status: number; body: unknown } {
  try {
    run();
  } catch (error) {
    const exception = error as HttpException;
    return { status: exception.getStatus(), body: exception.getResponse() };
  }
  throw new Error('expected the guard to throw');
}

beforeEach(() => {
  process.env.EVE_TOKEN = TOKEN;
});

afterEach(() => {
  delete process.env.EVE_TOKEN;
});

describe('EveTokenGuard', () => {
  it('accepts x-eve-token and a Bearer authorization header', () => {
    const guard = new EveTokenGuard();

    expect(
      guard.canActivate(context({ 'x-eve-token': TOKEN })),
    ).toBe(true);
    expect(
      guard.canActivate(context({ authorization: `Bearer ${TOKEN}` })),
    ).toBe(true);
  });

  it('rejects a missing or wrong token with EVE_UNAUTHORIZED', () => {
    const guard = new EveTokenGuard();

    for (const headers of [
      {},
      { 'x-eve-token': 'nope' },
      { authorization: 'Bearer nope' },
    ]) {
      const result = responseOf(() => guard.canActivate(context(headers)));
      expect(result.status).toBe(401);
      expect(result.body).toMatchObject({ code: 'EVE_UNAUTHORIZED' });
    }
  });

  it('disables the whole surface with 503 when EVE_TOKEN is empty', () => {
    delete process.env.EVE_TOKEN;
    const guard = new EveTokenGuard();

    const result = responseOf(() =>
      guard.canActivate(context({ 'x-eve-token': '' })),
    );

    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ code: 'EVE_DISABLED' });
  });
});
