import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Reads Orca's OpenCode Go token from the local OpenCode database.
 *
 * Mirrors `AiConfigService.readOpencodeToken()` (which cannot be imported here
 * without a module cycle) and adds the `key` shape used by non-OAuth
 * credentials. Cached for a minute because the DB file is large.
 */
const CACHE_MS = 60_000;

let cached: { token: string; at: number } | null = null;

export function readOpencodeToken(): string | null {
  if (process.env.AI_API_KEY_SOURCE !== 'opencode') return null;
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.token;
  const file =
    process.env.OPENCODE_DB?.trim() ||
    join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const row = db
        .prepare(
          "select value from credential where integration_id = 'opencode' and active = 1 order by time_updated desc limit 1",
        )
        .get() as { value?: unknown } | undefined;
      if (!row || typeof row.value !== 'string') return null;
      const parsed = JSON.parse(row.value) as {
        access?: unknown;
        key?: unknown;
      };
      const token =
        typeof parsed.access === 'string' && parsed.access.trim()
          ? parsed.access.trim()
          : typeof parsed.key === 'string' && parsed.key.trim()
            ? parsed.key.trim()
            : '';
      if (!token) return null;
      cached = { token, at: Date.now() };
      return token;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** Tests read the database themselves; forget the cached token afterwards. */
export function resetOpencodeTokenCache(): void {
  cached = null;
}
