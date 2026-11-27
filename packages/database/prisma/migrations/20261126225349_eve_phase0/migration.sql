-- CreateTable
CREATE TABLE "EvePersona" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "age" INTEGER NOT NULL DEFAULT 22,
    "nationality" TEXT NOT NULL DEFAULT 'RU',
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Moscow',
    "stage" TEXT NOT NULL DEFAULT 'tg-given-warming',
    "mode" TEXT NOT NULL DEFAULT 'auto',
    "sleepFrom" INTEGER NOT NULL DEFAULT 23,
    "sleepTo" INTEGER NOT NULL DEFAULT 8,
    "nightWakeChance" REAL NOT NULL DEFAULT 0.05,
    "ignoreTendency" INTEGER NOT NULL DEFAULT 35,
    "communication" TEXT NOT NULL DEFAULT '{}',
    "vibe" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "EvePersonaDoc" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "personaId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "updatedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EvePersonaDoc_personaId_fkey" FOREIGN KEY ("personaId") REFERENCES "EvePersona" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EvePersonaAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "personaId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "relationshipMode" TEXT NOT NULL DEFAULT 'isolated',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EvePersonaAccount_personaId_fkey" FOREIGN KEY ("personaId") REFERENCES "EvePersona" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EvePersonaAccount_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TelegramAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EveChatBinding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "personaId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "threadId" INTEGER NOT NULL DEFAULT 0,
    "allowed" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EveChatBinding_personaId_fkey" FOREIGN KEY ("personaId") REFERENCES "EvePersona" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EveChatBinding_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TelegramAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EveRelationship" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "personaId" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "stage" TEXT NOT NULL DEFAULT 'tg-given-warming',
    "interest" INTEGER NOT NULL DEFAULT 0,
    "trust" INTEGER NOT NULL DEFAULT 0,
    "attraction" INTEGER NOT NULL DEFAULT 0,
    "annoyance" INTEGER NOT NULL DEFAULT 0,
    "cringe" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT NOT NULL DEFAULT '',
    "updatedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EveRelationship_personaId_fkey" FOREIGN KEY ("personaId") REFERENCES "EvePersona" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EveRelationshipEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "relationshipId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'note',
    "text" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EveRelationshipEvent_relationshipId_fkey" FOREIGN KEY ("relationshipId") REFERENCES "EveRelationship" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EveConflict" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "relationshipId" TEXT NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 0,
    "coldUntil" DATETIME,
    "reason" TEXT,
    "history" TEXT NOT NULL DEFAULT '[]',
    "updatedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EveConflict_relationshipId_fkey" FOREIGN KEY ("relationshipId") REFERENCES "EveRelationship" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EveConflictEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conflictId" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "eveConflictId" TEXT,
    CONSTRAINT "EveConflictEvent_eveConflictId_fkey" FOREIGN KEY ("eveConflictId") REFERENCES "EveConflict" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EveAgendaItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "personaId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "about" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "kind" TEXT NOT NULL DEFAULT 'proactive-life',
    "state" TEXT NOT NULL DEFAULT 'pending',
    "importance" INTEGER NOT NULL DEFAULT 1,
    "pingAt" DATETIME NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "history" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "EveDailyLife" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "personaId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "markdown" TEXT NOT NULL DEFAULT '',
    "json" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "EveMemoryDaily" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "personaId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "markdown" TEXT NOT NULL DEFAULT '',
    "json" TEXT NOT NULL DEFAULT '{}',
    "complete" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "EveMemoryFact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "personaId" TEXT NOT NULL,
    "relationshipId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'fact',
    "content" TEXT NOT NULL,
    "importance" INTEGER NOT NULL DEFAULT 3,
    "source" TEXT NOT NULL DEFAULT 'agent',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "EveEpisode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "personaId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "EvePalaceDrawer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "personaId" TEXT NOT NULL,
    "drawerId" TEXT NOT NULL,
    "wing" TEXT NOT NULL,
    "hall" TEXT NOT NULL,
    "room" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "keywords" TEXT NOT NULL DEFAULT '[]',
    "salience" INTEGER NOT NULL DEFAULT 5,
    "source" TEXT NOT NULL DEFAULT 'interaction',
    "hash" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "EveTimeItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "personaId" TEXT NOT NULL,
    "relationshipId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'open-loop',
    "content" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "dueAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "EveCrossChatMemory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "personaId" TEXT NOT NULL,
    "peerId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "EveSessionLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "personaId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "day" TEXT NOT NULL,
    "line" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "EveSticker" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "personaId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "emoji" TEXT NOT NULL DEFAULT '',
    "tags" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "EveProactiveState" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "personaId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "marker" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "EveSessionState" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "personaId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "state" TEXT NOT NULL DEFAULT '{}',
    "updatedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "EveEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "personaId" TEXT,
    "accountId" TEXT,
    "chatId" BIGINT,
    "threadId" INTEGER NOT NULL DEFAULT 0,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" DATETIME
);

-- CreateIndex
CREATE INDEX "EvePersona_name_idx" ON "EvePersona"("name");

-- CreateIndex
CREATE UNIQUE INDEX "EvePersonaDoc_personaId_kind_key" ON "EvePersonaDoc"("personaId", "kind");

-- CreateIndex
CREATE INDEX "EvePersonaAccount_accountId_idx" ON "EvePersonaAccount"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "EvePersonaAccount_personaId_accountId_key" ON "EvePersonaAccount"("personaId", "accountId");

-- CreateIndex
CREATE INDEX "EveChatBinding_accountId_chatId_idx" ON "EveChatBinding"("accountId", "chatId");

-- CreateIndex
CREATE UNIQUE INDEX "EveChatBinding_personaId_accountId_chatId_threadId_key" ON "EveChatBinding"("personaId", "accountId", "chatId", "threadId");

-- CreateIndex
CREATE UNIQUE INDEX "EveRelationship_personaId_scopeKey_key" ON "EveRelationship"("personaId", "scopeKey");

-- CreateIndex
CREATE INDEX "EveRelationshipEvent_relationshipId_createdAt_idx" ON "EveRelationshipEvent"("relationshipId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "EveConflict_relationshipId_key" ON "EveConflict"("relationshipId");

-- CreateIndex
CREATE INDEX "EveConflictEvent_conflictId_createdAt_idx" ON "EveConflictEvent"("conflictId", "createdAt");

-- CreateIndex
CREATE INDEX "EveAgendaItem_personaId_state_pingAt_idx" ON "EveAgendaItem"("personaId", "state", "pingAt");

-- CreateIndex
CREATE INDEX "EveAgendaItem_accountId_chatId_idx" ON "EveAgendaItem"("accountId", "chatId");

-- CreateIndex
CREATE UNIQUE INDEX "EveDailyLife_personaId_date_key" ON "EveDailyLife"("personaId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "EveMemoryDaily_personaId_date_key" ON "EveMemoryDaily"("personaId", "date");

-- CreateIndex
CREATE INDEX "EveMemoryFact_personaId_kind_idx" ON "EveMemoryFact"("personaId", "kind");

-- CreateIndex
CREATE INDEX "EveMemoryFact_relationshipId_idx" ON "EveMemoryFact"("relationshipId");

-- CreateIndex
CREATE UNIQUE INDEX "EveEpisode_personaId_date_key" ON "EveEpisode"("personaId", "date");

-- CreateIndex
CREATE INDEX "EvePalaceDrawer_personaId_hall_idx" ON "EvePalaceDrawer"("personaId", "hall");

-- CreateIndex
CREATE UNIQUE INDEX "EvePalaceDrawer_personaId_drawerId_key" ON "EvePalaceDrawer"("personaId", "drawerId");

-- CreateIndex
CREATE INDEX "EveTimeItem_personaId_kind_status_idx" ON "EveTimeItem"("personaId", "kind", "status");

-- CreateIndex
CREATE INDEX "EveCrossChatMemory_personaId_peerId_idx" ON "EveCrossChatMemory"("personaId", "peerId");

-- CreateIndex
CREATE INDEX "EveSessionLog_personaId_day_idx" ON "EveSessionLog"("personaId", "day");

-- CreateIndex
CREATE INDEX "EveSessionLog_accountId_chatId_createdAt_idx" ON "EveSessionLog"("accountId", "chatId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "EveSticker_personaId_fileId_key" ON "EveSticker"("personaId", "fileId");

-- CreateIndex
CREATE UNIQUE INDEX "EveProactiveState_personaId_date_marker_key" ON "EveProactiveState"("personaId", "date", "marker");

-- CreateIndex
CREATE UNIQUE INDEX "EveSessionState_personaId_accountId_chatId_key" ON "EveSessionState"("personaId", "accountId", "chatId");

-- CreateIndex
CREATE INDEX "EveEvent_createdAt_idx" ON "EveEvent"("createdAt");

-- CreateIndex
CREATE INDEX "EveEvent_personaId_createdAt_idx" ON "EveEvent"("personaId", "createdAt");

-- CreateIndex
CREATE INDEX "EveEvent_deliveredAt_idx" ON "EveEvent"("deliveredAt");
