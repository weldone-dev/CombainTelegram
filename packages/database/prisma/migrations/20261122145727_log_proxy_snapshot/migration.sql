-- AlterTable
ALTER TABLE "LogEntry" ADD COLUMN "proxyId" TEXT;
ALTER TABLE "LogEntry" ADD COLUMN "proxyLabel" TEXT;
ALTER TABLE "LogEntry" ADD COLUMN "proxySnapshot" TEXT;

-- CreateIndex
CREATE INDEX "LogEntry_proxyId_createdAt_idx" ON "LogEntry"("proxyId", "createdAt");
