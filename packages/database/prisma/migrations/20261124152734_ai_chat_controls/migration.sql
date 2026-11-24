-- AlterTable
ALTER TABLE "AgentRun" ADD COLUMN "messageIds" TEXT;

-- CreateTable
CREATE TABLE "AiChatAccess" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "threadId" INTEGER NOT NULL DEFAULT 0,
    "soulId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AiChatAccess_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TelegramAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AiChatAccess_soulId_fkey" FOREIGN KEY ("soulId") REFERENCES "Soul" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AiChatBlock" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "threadId" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT,
    "warnings" INTEGER NOT NULL DEFAULT 0,
    "blockedBy" TEXT NOT NULL DEFAULT 'user',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AiChatBlock_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TelegramAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AiProvider" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'openai-compatible',
    "baseUrl" TEXT NOT NULL DEFAULT '',
    "apiKey" TEXT,
    "models" TEXT NOT NULL DEFAULT '[]',
    "defaultModel" TEXT,
    "reasoningEffort" TEXT NOT NULL DEFAULT 'low',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AiSetting" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'default',
    "provider" TEXT NOT NULL DEFAULT 'openai-compatible',
    "baseUrl" TEXT NOT NULL DEFAULT '',
    "model" TEXT NOT NULL DEFAULT '',
    "fastModel" TEXT NOT NULL DEFAULT '',
    "apiKeyEncrypted" BLOB,
    "apiKeyNonce" BLOB,
    "apiKeyTag" BLOB,
    "apiKeyDekWrapped" BLOB,
    "apiKeyDekNonce" BLOB,
    "apiKeyDekTag" BLOB,
    "temperature" REAL NOT NULL DEFAULT 0.7,
    "maxSteps" INTEGER NOT NULL DEFAULT 6,
    "reasoningEffort" TEXT NOT NULL DEFAULT 'low',
    "sttEngine" TEXT NOT NULL DEFAULT 'auto',
    "sttBaseUrl" TEXT NOT NULL DEFAULT '',
    "sttModel" TEXT,
    "sttApiKey" TEXT,
    "sttLanguage" TEXT NOT NULL DEFAULT 'auto',
    "dryRun" BOOLEAN NOT NULL DEFAULT true,
    "capabilities" TEXT NOT NULL DEFAULT '{}',
    "allowAccountIds" TEXT NOT NULL DEFAULT '[]',
    "allowChatIds" TEXT NOT NULL DEFAULT '[]',
    "blockChatIds" TEXT NOT NULL DEFAULT '[]',
    "ownerTgUserIds" TEXT NOT NULL DEFAULT '[]',
    "mcpTokenEncrypted" BLOB,
    "mcpTokenNonce" BLOB,
    "mcpTokenTag" BLOB,
    "mcpTokenDekWrapped" BLOB,
    "mcpTokenDekNonce" BLOB,
    "mcpTokenDekTag" BLOB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_AiSetting" ("allowAccountIds", "allowChatIds", "apiKeyDekNonce", "apiKeyDekTag", "apiKeyDekWrapped", "apiKeyEncrypted", "apiKeyNonce", "apiKeyTag", "baseUrl", "blockChatIds", "capabilities", "createdAt", "dryRun", "fastModel", "id", "maxSteps", "mcpTokenDekNonce", "mcpTokenDekTag", "mcpTokenDekWrapped", "mcpTokenEncrypted", "mcpTokenNonce", "mcpTokenTag", "model", "ownerTgUserIds", "provider", "reasoningEffort", "temperature", "updatedAt") SELECT "allowAccountIds", "allowChatIds", "apiKeyDekNonce", "apiKeyDekTag", "apiKeyDekWrapped", "apiKeyEncrypted", "apiKeyNonce", "apiKeyTag", "baseUrl", "blockChatIds", "capabilities", "createdAt", "dryRun", "fastModel", "id", "maxSteps", "mcpTokenDekNonce", "mcpTokenDekTag", "mcpTokenDekWrapped", "mcpTokenEncrypted", "mcpTokenNonce", "mcpTokenTag", "model", "ownerTgUserIds", "provider", "reasoningEffort", "temperature", "updatedAt" FROM "AiSetting";
DROP TABLE "AiSetting";
ALTER TABLE "new_AiSetting" RENAME TO "AiSetting";
CREATE TABLE "new_Automation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "triggerType" TEXT NOT NULL DEFAULT 'manual',
    "trigger" TEXT NOT NULL DEFAULT '{}',
    "actionType" TEXT NOT NULL DEFAULT 'agent',
    "action" TEXT NOT NULL DEFAULT '{}',
    "chatId" BIGINT,
    "threadId" INTEGER NOT NULL DEFAULT 0,
    "soulId" TEXT,
    "createdBy" TEXT NOT NULL DEFAULT 'user',
    "timezone" TEXT,
    "selfPausedAt" DATETIME,
    "selfPauseReason" TEXT,
    "lastRunAt" DATETIME,
    "nextRunAt" DATETIME,
    "runCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Automation_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TelegramAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Automation_soulId_fkey" FOREIGN KEY ("soulId") REFERENCES "Soul" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Automation" ("accountId", "action", "actionType", "createdAt", "description", "enabled", "id", "lastRunAt", "name", "nextRunAt", "runCount", "trigger", "triggerType", "updatedAt") SELECT "accountId", "action", "actionType", "createdAt", "description", "enabled", "id", "lastRunAt", "name", "nextRunAt", "runCount", "trigger", "triggerType", "updatedAt" FROM "Automation";
DROP TABLE "Automation";
ALTER TABLE "new_Automation" RENAME TO "Automation";
CREATE INDEX "Automation_enabled_nextRunAt_idx" ON "Automation"("enabled", "nextRunAt");
CREATE INDEX "Automation_accountId_chatId_idx" ON "Automation"("accountId", "chatId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "AiChatAccess_userId_idx" ON "AiChatAccess"("userId");

-- CreateIndex
CREATE INDEX "AiChatAccess_accountId_chatId_idx" ON "AiChatAccess"("accountId", "chatId");

-- CreateIndex
CREATE UNIQUE INDEX "AiChatAccess_accountId_chatId_threadId_key" ON "AiChatAccess"("accountId", "chatId", "threadId");

-- CreateIndex
CREATE INDEX "AiChatBlock_userId_idx" ON "AiChatBlock"("userId");

-- CreateIndex
CREATE INDEX "AiChatBlock_accountId_chatId_idx" ON "AiChatBlock"("accountId", "chatId");

-- CreateIndex
CREATE UNIQUE INDEX "AiChatBlock_accountId_chatId_threadId_key" ON "AiChatBlock"("accountId", "chatId", "threadId");
