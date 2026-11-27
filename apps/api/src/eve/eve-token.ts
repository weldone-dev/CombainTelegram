import { timingSafeEqual } from 'node:crypto';

/** Shared secret for the local Eve channel. Empty = the channel is disabled. */
export function eveToken(): string {
  return (process.env.EVE_TOKEN ?? '').trim();
}

export function eveTokenEnabled(): boolean {
  return eveToken().length > 0;
}

export function eveTokenMatches(given: string | undefined | null): boolean {
  const expected = eveToken();
  if (!expected || !given) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Reads `Authorization: Bearer` or `x-eve-token`. */
export function eveTokenFromHeaders(
  authorization: string | undefined,
  header: string | undefined,
): string | undefined {
  if (header?.trim()) return header.trim();
  const match = /^Bearer\s+(.+)$/i.exec(authorization?.trim() ?? '');
  return match?.[1]?.trim();
}
