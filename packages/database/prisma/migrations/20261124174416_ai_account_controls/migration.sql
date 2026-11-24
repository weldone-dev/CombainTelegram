-- CreateTable
CREATE TABLE "AiChatSkill" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "threadId" INTEGER NOT NULL DEFAULT 0,
    "skillSlugs" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AiChatSkill_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TelegramAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AiChatEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "threadId" INTEGER NOT NULL DEFAULT 0,
    "kind" TEXT NOT NULL,
    "reason" TEXT,
    "warnings" INTEGER NOT NULL DEFAULT 0,
    "actor" TEXT NOT NULL DEFAULT 'user',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiChatEvent_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TelegramAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AiAccountSetting" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "permissions" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AiAccountSetting_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TelegramAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AiProvider" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'openai-compatible',
    "preset" TEXT,
    "baseUrl" TEXT NOT NULL DEFAULT '',
    "apiKey" TEXT,
    "models" TEXT NOT NULL DEFAULT '[]',
    "defaultModel" TEXT,
    "reasoningEffort" TEXT NOT NULL DEFAULT 'low',
    "limits" TEXT NOT NULL DEFAULT '{}',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_AiProvider" ("apiKey", "baseUrl", "createdAt", "defaultModel", "enabled", "id", "isDefault", "kind", "models", "name", "reasoningEffort", "updatedAt") SELECT "apiKey", "baseUrl", "createdAt", "defaultModel", "enabled", "id", "isDefault", "kind", "models", "name", "reasoningEffort", "updatedAt" FROM "AiProvider";
DROP TABLE "AiProvider";
ALTER TABLE "new_AiProvider" RENAME TO "AiProvider";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "AiChatSkill_accountId_chatId_idx" ON "AiChatSkill"("accountId", "chatId");

-- CreateIndex
CREATE UNIQUE INDEX "AiChatSkill_accountId_chatId_threadId_key" ON "AiChatSkill"("accountId", "chatId", "threadId");

-- CreateIndex
CREATE INDEX "AiChatEvent_accountId_chatId_createdAt_idx" ON "AiChatEvent"("accountId", "chatId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AiAccountSetting_accountId_key" ON "AiAccountSetting"("accountId");
