-- AlterTable
ALTER TABLE "ResearchVideo" ADD COLUMN     "engine" TEXT,
ADD COLUMN     "style" TEXT NOT NULL DEFAULT 'cinematic';
