-- CreateTable
CREATE TABLE "AiChatSetting" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "threadId" INTEGER NOT NULL DEFAULT 0,
    "settings" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AiChatSetting_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TelegramAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
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
    "aiVariables" TEXT NOT NULL DEFAULT '{}',
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "activeSessionId" TEXT,
    "lastUsedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "workflowId" TEXT,
    CONSTRAINT "TelegramAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TelegramAccount_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_TelegramAccount" ("activeSessionId", "cloudPasswordEncrypted", "cloudPasswordNonce", "cloudPasswordTag", "createdAt", "deviceProfile", "firstName", "id", "isActive", "lastName", "lastUsedAt", "phoneEncrypted", "phoneNonce", "phoneTag", "tgUserId", "userId", "username", "workflowId") SELECT "activeSessionId", "cloudPasswordEncrypted", "cloudPasswordNonce", "cloudPasswordTag", "createdAt", "deviceProfile", "firstName", "id", "isActive", "lastName", "lastUsedAt", "phoneEncrypted", "phoneNonce", "phoneTag", "tgUserId", "userId", "username", "workflowId" FROM "TelegramAccount";
DROP TABLE "TelegramAccount";
ALTER TABLE "new_TelegramAccount" RENAME TO "TelegramAccount";
CREATE INDEX "TelegramAccount_userId_idx" ON "TelegramAccount"("userId");
CREATE INDEX "TelegramAccount_workflowId_idx" ON "TelegramAccount"("workflowId");
CREATE UNIQUE INDEX "TelegramAccount_userId_tgUserId_key" ON "TelegramAccount"("userId", "tgUserId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "AiChatSetting_accountId_chatId_idx" ON "AiChatSetting"("accountId", "chatId");

-- CreateIndex
CREATE UNIQUE INDEX "AiChatSetting_accountId_chatId_threadId_key" ON "AiChatSetting"("accountId", "chatId", "threadId");
