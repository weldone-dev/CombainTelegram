-- CreateTable
CREATE TABLE "AiChatTag" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "tag" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiChatTag_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TelegramAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "AiChatTag_accountId_chatId_idx" ON "AiChatTag"("accountId", "chatId");

-- CreateIndex
CREATE UNIQUE INDEX "AiChatTag_accountId_chatId_tag_key" ON "AiChatTag"("accountId", "chatId", "tag");
