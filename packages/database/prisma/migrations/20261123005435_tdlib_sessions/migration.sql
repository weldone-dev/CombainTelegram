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
    "engine" TEXT NOT NULL DEFAULT 'mtcute',
    "dcId" INTEGER NOT NULL,
    "apiId" INTEGER NOT NULL,
    "proxyId" TEXT,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "cipher" BLOB,
    "nonce" BLOB,
    "tag" BLOB,
    "dekWrapped" BLOB,
    "dekNonce" BLOB,
    "dekTag" BLOB,
    "tdlibPath" TEXT,
    "tdlibKeyEncrypted" BLOB,
    "tdlibKeyNonce" BLOB,
    "tdlibKeyTag" BLOB,
    "revokedAt" DATETIME,
    "lastUsedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TelegramSession_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TelegramAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TelegramSession_proxyId_fkey" FOREIGN KEY ("proxyId") REFERENCES "Proxy" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_TelegramSession" ("accountId", "apiId", "cipher", "createdAt", "dcId", "dekNonce", "dekTag", "dekWrapped", "deviceId", "id", "keyVersion", "label", "lastUsedAt", "nonce", "platform", "profile", "proxyId", "revokedAt", "tag") SELECT "accountId", "apiId", "cipher", "createdAt", "dcId", "dekNonce", "dekTag", "dekWrapped", "deviceId", "id", "keyVersion", "label", "lastUsedAt", "nonce", "platform", "profile", "proxyId", "revokedAt", "tag" FROM "TelegramSession";
DROP TABLE "TelegramSession";
ALTER TABLE "new_TelegramSession" RENAME TO "TelegramSession";
CREATE INDEX "TelegramSession_accountId_idx" ON "TelegramSession"("accountId");
CREATE UNIQUE INDEX "TelegramSession_accountId_deviceId_key" ON "TelegramSession"("accountId", "deviceId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
