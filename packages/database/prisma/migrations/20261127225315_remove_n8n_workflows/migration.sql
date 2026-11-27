/*
  Warnings:

  - You are about to drop the `IntegrationEvent` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Workflow` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the column `workflowId` on the `TelegramAccount` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "IntegrationEvent_userId_deliveredAt_idx";

-- DropIndex
DROP INDEX "IntegrationEvent_userId_createdAt_idx";

-- DropIndex
DROP INDEX "Workflow_userId_createdAt_idx";

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "IntegrationEvent";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "Workflow";
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
    "aiVariables" TEXT NOT NULL DEFAULT '{}',
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "activeSessionId" TEXT,
    "lastUsedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TelegramAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_TelegramAccount" ("activeSessionId", "aiVariables", "cloudPasswordEncrypted", "cloudPasswordNonce", "cloudPasswordTag", "createdAt", "deviceProfile", "firstName", "id", "isActive", "lastName", "lastUsedAt", "phoneEncrypted", "phoneNonce", "phoneTag", "tgUserId", "userId", "username") SELECT "activeSessionId", "aiVariables", "cloudPasswordEncrypted", "cloudPasswordNonce", "cloudPasswordTag", "createdAt", "deviceProfile", "firstName", "id", "isActive", "lastName", "lastUsedAt", "phoneEncrypted", "phoneNonce", "phoneTag", "tgUserId", "userId", "username" FROM "TelegramAccount";
DROP TABLE "TelegramAccount";
ALTER TABLE "new_TelegramAccount" RENAME TO "TelegramAccount";
CREATE INDEX "TelegramAccount_userId_idx" ON "TelegramAccount"("userId");
CREATE UNIQUE INDEX "TelegramAccount_userId_tgUserId_key" ON "TelegramAccount"("userId", "tgUserId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
