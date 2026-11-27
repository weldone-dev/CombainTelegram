-- Durable claim for EveEvent dedupe keys. A separate table keeps the existing
-- EveEvent rows (including duplicate keys written before the fix) untouched.
CREATE TABLE "EveEventDedupe" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "EveEventDedupe_createdAt_idx" ON "EveEventDedupe"("createdAt");
