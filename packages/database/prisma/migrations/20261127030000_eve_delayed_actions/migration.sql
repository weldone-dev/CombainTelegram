-- CreateTable
CREATE TABLE "EveDelayedAction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "personaId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "threadId" INTEGER NOT NULL DEFAULT 0,
    "kind" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT 'delay',
    "key" TEXT,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "dueAt" DATETIME,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "firedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "EveDelayedAction_personaId_key_key" ON "EveDelayedAction"("personaId", "key");

-- CreateIndex
CREATE INDEX "EveDelayedAction_state_dueAt_idx" ON "EveDelayedAction"("state", "dueAt");

-- CreateIndex
CREATE INDEX "EveDelayedAction_personaId_state_idx" ON "EveDelayedAction"("personaId", "state");

-- CreateIndex
CREATE INDEX "EveDelayedAction_accountId_chatId_idx" ON "EveDelayedAction"("accountId", "chatId");
