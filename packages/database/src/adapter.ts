import path from 'node:path';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';

// `src/` and `dist/` are both one level below the package root.
const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');

/**
 * Prisma 7 requires a driver adapter. Resolves the SQLite path against this
 * package so `file:./prisma/dev.db` works no matter which app starts the process.
 */
export function createSqliteAdapter(url = process.env.DATABASE_URL ?? 'file:./prisma/dev.db') {
  return new PrismaBetterSqlite3({ url: resolveSqliteUrl(url) });
}

function resolveSqliteUrl(url: string): string {
  if (url === ':memory:' || url.startsWith('file::memory:')) {
    return url;
  }

  if (!url.startsWith('file:')) {
    return url;
  }

  const filePath = url.slice('file:'.length);
  return path.isAbsolute(filePath) ? url : `file:${path.resolve(PACKAGE_ROOT, filePath)}`;
}
