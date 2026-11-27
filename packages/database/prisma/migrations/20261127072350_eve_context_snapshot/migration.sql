-- CreateTable
CREATE TABLE "EveContextSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "personaId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "threadId" INTEGER NOT NULL DEFAULT 0,
    "kind" TEXT NOT NULL DEFAULT 'other',
    "model" TEXT NOT NULL DEFAULT '',
    "turnId" TEXT,
    "tokensJson" TEXT NOT NULL DEFAULT '{}',
    "systemJson" TEXT NOT NULL DEFAULT '[]',
    "messagesJson" TEXT NOT NULL DEFAULT '[]',
    "metaJson" TEXT NOT NULL DEFAULT '{}',
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "EveContextSnapshot_personaId_chatId_createdAt_idx" ON "EveContextSnapshot"("personaId", "chatId", "createdAt");

-- CreateIndex
CREATE INDEX "EveContextSnapshot_personaId_accountId_createdAt_idx" ON "EveContextSnapshot"("personaId", "accountId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "EveContextSnapshot_personaId_accountId_chatId_turnId_key" ON "EveContextSnapshot"("personaId", "accountId", "chatId", "turnId");
