-- AlterTable
ALTER TABLE "AiSetting" ADD COLUMN "mcpTokenDekNonce" BLOB;
ALTER TABLE "AiSetting" ADD COLUMN "mcpTokenDekTag" BLOB;
ALTER TABLE "AiSetting" ADD COLUMN "mcpTokenDekWrapped" BLOB;

-- AlterTable
ALTER TABLE "TelegramBot" ADD COLUMN "tokenDekNonce" BLOB;
ALTER TABLE "TelegramBot" ADD COLUMN "tokenDekTag" BLOB;
ALTER TABLE "TelegramBot" ADD COLUMN "tokenDekWrapped" BLOB;
