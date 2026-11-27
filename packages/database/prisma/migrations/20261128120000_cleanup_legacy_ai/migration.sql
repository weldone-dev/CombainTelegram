-- DropIndex
DROP INDEX "AgentRun_source_createdAt_idx";

-- DropIndex
DROP INDEX "AgentRun_accountId_createdAt_idx";

-- DropIndex
DROP INDEX "AiAccountSetting_accountId_key";

-- DropIndex
DROP INDEX "AiChatAccess_accountId_chatId_threadId_key";

-- DropIndex
DROP INDEX "AiChatAccess_accountId_chatId_idx";

-- DropIndex
DROP INDEX "AiChatAccess_userId_idx";

-- DropIndex
DROP INDEX "AiChatBlock_accountId_chatId_threadId_key";

-- DropIndex
DROP INDEX "AiChatBlock_accountId_chatId_idx";

-- DropIndex
DROP INDEX "AiChatBlock_userId_idx";

-- DropIndex
DROP INDEX "AiChatEvent_accountId_chatId_createdAt_idx";

-- DropIndex
DROP INDEX "AiChatSetting_accountId_chatId_threadId_key";

-- DropIndex
DROP INDEX "AiChatSetting_accountId_chatId_idx";

-- DropIndex
DROP INDEX "AiChatSkill_accountId_chatId_threadId_key";

-- DropIndex
DROP INDEX "AiChatSkill_accountId_chatId_idx";

-- DropIndex
DROP INDEX "AiChatTag_accountId_chatId_tag_key";

-- DropIndex
DROP INDEX "AiChatTag_accountId_chatId_idx";

-- DropIndex
DROP INDEX "Automation_accountId_chatId_idx";

-- DropIndex
DROP INDEX "Automation_enabled_nextRunAt_idx";

-- DropIndex
DROP INDEX "AutomationRun_automationId_startedAt_idx";

-- DropIndex
DROP INDEX "BotTurn_botId_chatId_createdAt_idx";

-- DropIndex
DROP INDEX "Skill_slug_key";

-- DropIndex
DROP INDEX "Soul_accountId_key";

-- DropIndex
DROP INDEX "SoulMemory_accountId_chatId_createdAt_idx";

-- DropIndex
DROP INDEX "SoulSummary_accountId_chatId_key";

-- DropIndex
DROP INDEX "SoulSummary_accountId_idx";

-- DropIndex
DROP INDEX "SoulTurn_accountId_chatId_createdAt_idx";

-- DropIndex
DROP INDEX "TelegramBot_accountId_key";

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "AgentRun";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "AiAccountSetting";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "AiChatAccess";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "AiChatBlock";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "AiChatEvent";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "AiChatSetting";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "AiChatSkill";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "AiChatTag";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "AiProvider";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "Automation";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "AutomationRun";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "BotSkill";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "BotTurn";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "Skill";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "Soul";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "SoulMemory";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "SoulSkill";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "SoulSummary";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "SoulTurn";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "TelegramBot";
PRAGMA foreign_keys=on;

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
    CONSTRAINT "TelegramAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_TelegramAccount" ("activeSessionId", "cloudPasswordEncrypted", "cloudPasswordNonce", "cloudPasswordTag", "createdAt", "deviceProfile", "firstName", "id", "isActive", "lastName", "lastUsedAt", "phoneEncrypted", "phoneNonce", "phoneTag", "tgUserId", "userId", "username") SELECT "activeSessionId", "cloudPasswordEncrypted", "cloudPasswordNonce", "cloudPasswordTag", "createdAt", "deviceProfile", "firstName", "id", "isActive", "lastName", "lastUsedAt", "phoneEncrypted", "phoneNonce", "phoneTag", "tgUserId", "userId", "username" FROM "TelegramAccount";
DROP TABLE "TelegramAccount";
ALTER TABLE "new_TelegramAccount" RENAME TO "TelegramAccount";
CREATE INDEX "TelegramAccount_userId_idx" ON "TelegramAccount"("userId");
CREATE UNIQUE INDEX "TelegramAccount_userId_tgUserId_key" ON "TelegramAccount"("userId", "tgUserId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

