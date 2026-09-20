-- CreateEnum
CREATE TYPE "FilmstripStatus" AS ENUM ('NONE', 'PENDING', 'READY', 'FAILED');

-- AlterTable
ALTER TABLE "VideoSource" ADD COLUMN     "filmstripColumns" INTEGER,
ADD COLUMN     "filmstripCount" INTEGER,
ADD COLUMN     "filmstripError" TEXT,
ADD COLUMN     "filmstripFrameHeight" INTEGER,
ADD COLUMN     "filmstripFrameWidth" INTEGER,
ADD COLUMN     "filmstripKey" TEXT,
ADD COLUMN     "filmstripStatus" "FilmstripStatus" NOT NULL DEFAULT 'NONE';
