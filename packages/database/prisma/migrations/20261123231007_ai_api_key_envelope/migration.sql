-- AlterTable
ALTER TABLE "AiSetting" ADD COLUMN "apiKeyDekNonce" BLOB;
ALTER TABLE "AiSetting" ADD COLUMN "apiKeyDekTag" BLOB;
ALTER TABLE "AiSetting" ADD COLUMN "apiKeyDekWrapped" BLOB;
