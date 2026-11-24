-- AlterTable
ALTER TABLE "AgentRun" ADD COLUMN "reasoning" TEXT;

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
INSERT INTO "new_AiSetting" ("allowAccountIds", "allowChatIds", "apiKeyDekNonce", "apiKeyDekTag", "apiKeyDekWrapped", "apiKeyEncrypted", "apiKeyNonce", "apiKeyTag", "baseUrl", "blockChatIds", "capabilities", "createdAt", "dryRun", "fastModel", "id", "maxSteps", "mcpTokenDekNonce", "mcpTokenDekTag", "mcpTokenDekWrapped", "mcpTokenEncrypted", "mcpTokenNonce", "mcpTokenTag", "model", "ownerTgUserIds", "provider", "temperature", "updatedAt") SELECT "allowAccountIds", "allowChatIds", "apiKeyDekNonce", "apiKeyDekTag", "apiKeyDekWrapped", "apiKeyEncrypted", "apiKeyNonce", "apiKeyTag", "baseUrl", "blockChatIds", "capabilities", "createdAt", "dryRun", "fastModel", "id", "maxSteps", "mcpTokenDekNonce", "mcpTokenDekTag", "mcpTokenDekWrapped", "mcpTokenEncrypted", "mcpTokenNonce", "mcpTokenTag", "model", "ownerTgUserIds", "provider", "temperature", "updatedAt" FROM "AiSetting";
DROP TABLE "AiSetting";
ALTER TABLE "new_AiSetting" RENAME TO "AiSetting";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
