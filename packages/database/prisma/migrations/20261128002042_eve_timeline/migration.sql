-- CreateTable
CREATE TABLE "EveRelationshipChange" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "relationshipId" TEXT NOT NULL,
    "personaId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "threadId" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'inbound',
    "delta" TEXT NOT NULL DEFAULT '{}',
    "before" TEXT NOT NULL DEFAULT '{}',
    "after" TEXT NOT NULL DEFAULT '{}',
    "stageFrom" TEXT,
    "stageTo" TEXT,
    "conflictBefore" INTEGER,
    "conflictAfter" INTEGER,
    "turnKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EveRelationshipChange_relationshipId_fkey" FOREIGN KEY ("relationshipId") REFERENCES "EveRelationship" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_EveSessionLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "personaId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "threadId" INTEGER NOT NULL DEFAULT 0,
    "day" TEXT NOT NULL,
    "line" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_EveSessionLog" ("accountId", "chatId", "createdAt", "day", "id", "line", "personaId") SELECT "accountId", "chatId", "createdAt", "day", "id", "line", "personaId" FROM "EveSessionLog";
DROP TABLE "EveSessionLog";
ALTER TABLE "new_EveSessionLog" RENAME TO "EveSessionLog";
CREATE INDEX "EveSessionLog_personaId_day_idx" ON "EveSessionLog"("personaId", "day");
CREATE INDEX "EveSessionLog_accountId_chatId_createdAt_idx" ON "EveSessionLog"("accountId", "chatId", "createdAt");
CREATE INDEX "EveSessionLog_personaId_accountId_chatId_threadId_createdAt_idx" ON "EveSessionLog"("personaId", "accountId", "chatId", "threadId", "createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "EveRelationshipChange_personaId_accountId_chatId_threadId_createdAt_idx" ON "EveRelationshipChange"("personaId", "accountId", "chatId", "threadId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "EveRelationshipChange_relationshipId_turnKey_key" ON "EveRelationshipChange"("relationshipId", "turnKey");
