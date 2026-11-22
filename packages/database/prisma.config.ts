import path from 'node:path';
import { defineConfig } from 'prisma/config';

// Keep the SQLite file inside this package regardless of the caller's cwd.
const defaultUrl = `file:${path.resolve(import.meta.dirname, 'prisma', 'dev.db')}`;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? defaultUrl,
  },
});
