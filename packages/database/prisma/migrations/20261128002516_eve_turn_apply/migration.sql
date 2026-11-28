-- CreateTable
CREATE TABLE "EveTurnApply" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "personaId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "threadId" INTEGER NOT NULL DEFAULT 0,
    "turnKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "EveTurnApply_createdAt_idx" ON "EveTurnApply"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "EveTurnApply_personaId_accountId_chatId_threadId_turnKey_key" ON "EveTurnApply"("personaId", "accountId", "chatId", "threadId", "turnKey");
