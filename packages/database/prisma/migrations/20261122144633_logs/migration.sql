-- CreateTable
CREATE TABLE "LogEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "level" TEXT NOT NULL DEFAULT 'info',
    "source" TEXT NOT NULL DEFAULT 'app',
    "action" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" TEXT,
    "requestId" TEXT,
    "userId" TEXT,
    "accountId" TEXT,
    "sessionId" TEXT,
    "chatId" INTEGER,
    "attemptId" TEXT,
    "durationMs" INTEGER,
    "errorCode" TEXT,
    "telegramMethod" TEXT,
    "telegramError" TEXT,
    "telegramResponse" TEXT,
    "details" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "LogEntry_createdAt_idx" ON "LogEntry"("createdAt");

-- CreateIndex
CREATE INDEX "LogEntry_level_createdAt_idx" ON "LogEntry"("level", "createdAt");

-- CreateIndex
CREATE INDEX "LogEntry_source_createdAt_idx" ON "LogEntry"("source", "createdAt");

-- CreateIndex
CREATE INDEX "LogEntry_accountId_createdAt_idx" ON "LogEntry"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "LogEntry_requestId_idx" ON "LogEntry"("requestId");
