/*
  Warnings:

  - Added the required column `deviceId` to the `TelegramSession` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_TelegramSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "label" TEXT,
    "platform" TEXT NOT NULL DEFAULT 'desktop',
    "profile" TEXT NOT NULL DEFAULT 'TelegramDesktop',
    "dcId" INTEGER NOT NULL,
    "apiId" INTEGER NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "cipher" BLOB NOT NULL,
    "nonce" BLOB NOT NULL,
    "tag" BLOB NOT NULL,
    "dekWrapped" BLOB NOT NULL,
    "dekNonce" BLOB NOT NULL,
    "dekTag" BLOB NOT NULL,
    "revokedAt" DATETIME,
    "lastUsedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TelegramSession_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TelegramAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_TelegramSession" ("accountId", "apiId", "cipher", "createdAt", "dcId", "dekNonce", "dekTag", "dekWrapped", "id", "keyVersion", "lastUsedAt", "nonce", "revokedAt", "tag") SELECT "accountId", "apiId", "cipher", "createdAt", "dcId", "dekNonce", "dekTag", "dekWrapped", "id", "keyVersion", "lastUsedAt", "nonce", "revokedAt", "tag" FROM "TelegramSession";
DROP TABLE "TelegramSession";
ALTER TABLE "new_TelegramSession" RENAME TO "TelegramSession";
CREATE INDEX "TelegramSession_accountId_idx" ON "TelegramSession"("accountId");
CREATE UNIQUE INDEX "TelegramSession_accountId_deviceId_key" ON "TelegramSession"("accountId", "deviceId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
