-- AlterTable
ALTER TABLE "TelegramAccount" ADD COLUMN "cloudPasswordEncrypted" BLOB;
ALTER TABLE "TelegramAccount" ADD COLUMN "cloudPasswordNonce" BLOB;
ALTER TABLE "TelegramAccount" ADD COLUMN "cloudPasswordTag" BLOB;
