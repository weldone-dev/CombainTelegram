-- CreateTable
CREATE TABLE "Workflow" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "n8nWorkflowId" TEXT,
    "n8nWorkflowName" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "isDraft" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "IntegrationEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "accountId" TEXT,
    "chatId" BIGINT,
    "threadId" INTEGER NOT NULL DEFAULT 0,
    "payload" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" DATETIME
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_TelegramAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "tgUserId" BIGINT NOT NULL,
    "phoneEncrypted" BLOB,
    "phoneNonce" BLOB,
    "phoneTag" BLOB,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT,
    "username" TEXT,
    "cloudPasswordEncrypted" BLOB,
    "cloudPasswordNonce" BLOB,
    "cloudPasswordTag" BLOB,
    "deviceProfile" TEXT NOT NULL DEFAULT '{}',
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "activeSessionId" TEXT,
    "lastUsedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "workflowId" TEXT,
    CONSTRAINT "TelegramAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TelegramAccount_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_TelegramAccount" ("activeSessionId", "cloudPasswordEncrypted", "cloudPasswordNonce", "cloudPasswordTag", "createdAt", "deviceProfile", "firstName", "id", "isActive", "lastName", "lastUsedAt", "phoneEncrypted", "phoneNonce", "phoneTag", "tgUserId", "userId", "username") SELECT "activeSessionId", "cloudPasswordEncrypted", "cloudPasswordNonce", "cloudPasswordTag", "createdAt", "deviceProfile", "firstName", "id", "isActive", "lastName", "lastUsedAt", "phoneEncrypted", "phoneNonce", "phoneTag", "tgUserId", "userId", "username" FROM "TelegramAccount";
DROP TABLE "TelegramAccount";
ALTER TABLE "new_TelegramAccount" RENAME TO "TelegramAccount";
CREATE INDEX "TelegramAccount_userId_idx" ON "TelegramAccount"("userId");
CREATE INDEX "TelegramAccount_workflowId_idx" ON "TelegramAccount"("workflowId");
CREATE UNIQUE INDEX "TelegramAccount_userId_tgUserId_key" ON "TelegramAccount"("userId", "tgUserId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Workflow_userId_createdAt_idx" ON "Workflow"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "IntegrationEvent_userId_createdAt_idx" ON "IntegrationEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "IntegrationEvent_userId_deliveredAt_idx" ON "IntegrationEvent"("userId", "deliveredAt");
