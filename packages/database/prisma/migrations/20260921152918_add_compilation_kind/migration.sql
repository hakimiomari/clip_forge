-- AlterTable
ALTER TABLE "ResearchVideo" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'RESEARCH',
ADD COLUMN     "targetSeconds" INTEGER;
