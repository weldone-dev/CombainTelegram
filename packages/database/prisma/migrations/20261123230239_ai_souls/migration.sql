-- CreateTable
CREATE TABLE "Soul" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "essence" TEXT NOT NULL DEFAULT '',
    "tone" TEXT NOT NULL DEFAULT '',
    "goals" TEXT NOT NULL DEFAULT '',
    "boundaries" TEXT NOT NULL DEFAULT '',
    "language" TEXT NOT NULL DEFAULT 'ru',
    "systemPrompt" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'off',
    "settings" TEXT NOT NULL DEFAULT '{}',
    "model" TEXT,
    "temperature" REAL NOT NULL DEFAULT 0.7,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Soul_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TelegramAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SoulSkill" (
    "soulId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,

    PRIMARY KEY ("soulId", "skillId"),
    CONSTRAINT "SoulSkill_soulId_fkey" FOREIGN KEY ("soulId") REFERENCES "Soul" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SoulSkill_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Skill" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "instructions" TEXT NOT NULL,
    "tools" TEXT NOT NULL DEFAULT '[]',
    "origin" TEXT NOT NULL DEFAULT 'user',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SoulTurn" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "messageId" BIGINT,
    "runId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "SoulSummary" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "facts" TEXT NOT NULL DEFAULT '[]',
    "turnsThrough" DATETIME,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SoulMemory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "chatId" BIGINT,
    "kind" TEXT NOT NULL DEFAULT 'fact',
    "content" TEXT NOT NULL,
    "importance" INTEGER NOT NULL DEFAULT 1,
    "source" TEXT NOT NULL DEFAULT 'agent',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" DATETIME
);

-- CreateTable
CREATE TABLE "TelegramBot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT,
    "username" TEXT,
    "title" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'assistant',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "tokenEncrypted" BLOB,
    "tokenNonce" BLOB,
    "tokenTag" BLOB,
    "allowedUserIds" TEXT NOT NULL DEFAULT '[]',
    "lastUpdateId" BIGINT NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lastPolledAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TelegramBot_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TelegramAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BotSkill" (
    "botId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,

    PRIMARY KEY ("botId", "skillId"),
    CONSTRAINT "BotSkill_botId_fkey" FOREIGN KEY ("botId") REFERENCES "TelegramBot" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BotSkill_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BotTurn" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "botId" TEXT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BotTurn_botId_fkey" FOREIGN KEY ("botId") REFERENCES "TelegramBot" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Automation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "triggerType" TEXT NOT NULL DEFAULT 'manual',
    "trigger" TEXT NOT NULL DEFAULT '{}',
    "actionType" TEXT NOT NULL DEFAULT 'agent',
    "action" TEXT NOT NULL DEFAULT '{}',
    "lastRunAt" DATETIME,
    "nextRunAt" DATETIME,
    "runCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Automation_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TelegramAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AutomationRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "automationId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "input" TEXT NOT NULL DEFAULT '{}',
    "output" TEXT,
    "error" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    CONSTRAINT "AutomationRun_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AiSetting" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'default',
    "provider" TEXT NOT NULL DEFAULT 'openai-compatible',
    "baseUrl" TEXT NOT NULL DEFAULT '',
    "model" TEXT NOT NULL DEFAULT '',
    "fastModel" TEXT NOT NULL DEFAULT '',
    "apiKeyEncrypted" BLOB,
    "apiKeyNonce" BLOB,
    "apiKeyTag" BLOB,
    "temperature" REAL NOT NULL DEFAULT 0.7,
    "maxSteps" INTEGER NOT NULL DEFAULT 6,
    "dryRun" BOOLEAN NOT NULL DEFAULT true,
    "capabilities" TEXT NOT NULL DEFAULT '{}',
    "allowAccountIds" TEXT NOT NULL DEFAULT '[]',
    "allowChatIds" TEXT NOT NULL DEFAULT '[]',
    "blockChatIds" TEXT NOT NULL DEFAULT '[]',
    "ownerTgUserIds" TEXT NOT NULL DEFAULT '[]',
    "mcpTokenEncrypted" BLOB,
    "mcpTokenNonce" BLOB,
    "mcpTokenTag" BLOB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT,
    "soulId" TEXT,
    "chatId" BIGINT,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "prompt" TEXT NOT NULL,
    "output" TEXT,
    "model" TEXT,
    "steps" INTEGER NOT NULL DEFAULT 0,
    "trace" TEXT NOT NULL DEFAULT '[]',
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME
);

-- CreateIndex
CREATE UNIQUE INDEX "Soul_accountId_key" ON "Soul"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "Skill_slug_key" ON "Skill"("slug");

-- CreateIndex
CREATE INDEX "SoulTurn_accountId_chatId_createdAt_idx" ON "SoulTurn"("accountId", "chatId", "createdAt");

-- CreateIndex
CREATE INDEX "SoulSummary_accountId_idx" ON "SoulSummary"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "SoulSummary_accountId_chatId_key" ON "SoulSummary"("accountId", "chatId");

-- CreateIndex
CREATE INDEX "SoulMemory_accountId_chatId_createdAt_idx" ON "SoulMemory"("accountId", "chatId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramBot_accountId_key" ON "TelegramBot"("accountId");

-- CreateIndex
CREATE INDEX "BotTurn_botId_chatId_createdAt_idx" ON "BotTurn"("botId", "chatId", "createdAt");

-- CreateIndex
CREATE INDEX "Automation_enabled_nextRunAt_idx" ON "Automation"("enabled", "nextRunAt");

-- CreateIndex
CREATE INDEX "AutomationRun_automationId_startedAt_idx" ON "AutomationRun"("automationId", "startedAt");

-- CreateIndex
CREATE INDEX "AgentRun_accountId_createdAt_idx" ON "AgentRun"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentRun_source_createdAt_idx" ON "AgentRun"("source", "createdAt");
