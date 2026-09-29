-- CreateTable
CREATE TABLE "PhotoSet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "title" TEXT,
    "channel" TEXT,
    "duration" DOUBLE PRECISION,
    "mode" TEXT NOT NULL DEFAULT 'scenes',
    "count" INTEGER NOT NULL DEFAULT 24,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "step" TEXT,
    "error" TEXT,
    "photos" JSONB,
    "zipKey" TEXT,
    "zipBytes" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PhotoSet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PhotoSet_userId_createdAt_idx" ON "PhotoSet"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "PhotoSet" ADD CONSTRAINT "PhotoSet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
