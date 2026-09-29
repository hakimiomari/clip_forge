-- AlterTable
ALTER TABLE "VideoSource" ADD COLUMN     "downloadBytes" BIGINT,
ADD COLUMN     "downloadError" TEXT,
ADD COLUMN     "downloadHeight" INTEGER,
ADD COLUMN     "downloadKey" TEXT,
ADD COLUMN     "downloadProgress" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "downloadStatus" TEXT NOT NULL DEFAULT 'NONE',
ADD COLUMN     "downloadWidth" INTEGER;
