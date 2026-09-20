-- CreateEnum
CREATE TYPE "ResearchStatus" AS ENUM ('PENDING', 'RESEARCHING', 'BUILDING', 'RENDERING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "ResearchVideo" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "status" "ResearchStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "format" TEXT NOT NULL DEFAULT 'vertical',
    "scenes" JSONB,
    "storageKey" TEXT,
    "thumbnailKey" TEXT,
    "duration" DOUBLE PRECISION,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "step" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResearchVideo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ResearchVideo_userId_createdAt_idx" ON "ResearchVideo"("userId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "ResearchVideo" ADD CONSTRAINT "ResearchVideo_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
