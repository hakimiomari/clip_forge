import type { Job } from "bullmq";
import { stat } from "fs/promises";
import path from "path";
import { getPrismaClient } from "@clipforge/database";
import { CREDIT_COSTS, type VideoImportJob } from "@clipforge/shared-types";
import { extractAudio, generateThumbnail, probeVideo } from "../lib/ffmpeg";
import { uploadFile } from "../lib/storage";
import { createWorkDir, fetchToWorkDir, type WorkDir } from "../lib/media";
import { publishProgress } from "../lib/progress";
import { refundCredits } from "../lib/credits";
import { fetchYouTubeInfo } from "../lib/youtube";

const MAX_SOURCE_DURATION_SECONDS = 4 * 60 * 60; // 4 hours

type Progress = (progressPct: number, step: string) => Promise<void>;

/**
 * video-import: turns an attached source into a fully described,
 * processing-ready VideoSource.
 *
 *  UPLOAD  → download from storage, ffprobe metadata, thumbnail,
 *            extract transcription audio, mark IMPORTED.
 *  YOUTUBE → metadata only (title, thumbnail, duration, dimensions).
 *            The video is never downloaded in full: analysis streams
 *            it and rendering fetches just the seconds a clip needs.
 */
export async function processVideoImport(
  job: Job<VideoImportJob>,
): Promise<void> {
  const { projectId, userId } = job.data;
  const prisma = getPrismaClient();

  const progress: Progress = (progressPct, step) =>
    publishProgress({
      projectId,
      status: "IMPORTING",
      progress: progressPct,
      step,
    });

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { source: true },
  });
  if (!project || !project.source) {
    throw new Error(`Project ${projectId} or its source no longer exists`);
  }
  if (project.userId !== userId) {
    throw new Error(`Job user mismatch for project ${projectId}`);
  }

  await prisma.project.update({
    where: { id: projectId },
    data: { status: "IMPORTING", error: null },
  });

  const work = await createWorkDir(`import-${projectId}`);
  try {
    if (project.source.sourceType === "UPLOAD") {
      await importUpload(work, projectId, userId, project.source.storageKey, progress);
    } else if (project.source.sourceType === "YOUTUBE") {
      await importYouTube(projectId, project.source.externalId, progress);
    } else {
      throw new Error(`Unsupported source type ${project.source.sourceType}`);
    }

    await prisma.project.update({
      where: { id: projectId },
      data: { status: "IMPORTED" },
    });
    await publishProgress({
      projectId,
      status: "IMPORTED",
      progress: 100,
      step: "Import complete",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    if (isFinalAttempt) {
      await prisma.project.update({
        where: { id: projectId },
        data: { status: "FAILED", error: message.slice(0, 1000) },
      });
      await refundCredits(userId, CREDIT_COSTS.importVideo, { projectId });
      await publishProgress({
        projectId,
        status: "FAILED",
        progress: 0,
        step: "Import failed",
        error: message,
      });
    }
    throw err;
  } finally {
    await work.cleanup();
  }
}

async function importUpload(
  work: WorkDir,
  projectId: string,
  userId: string,
  storageKey: string | null,
  progress: Progress,
): Promise<void> {
  if (!storageKey) throw new Error("Upload source has no storage key");
  const prisma = getPrismaClient();

  await progress(10, "Downloading uploaded video");
  const localSource = await fetchToWorkDir(work, storageKey, "source");
  const { size } = await stat(localSource);

  await progress(35, "Reading video metadata");
  const probe = await probeVideo(localSource);
  if (probe.durationSeconds > MAX_SOURCE_DURATION_SECONDS) {
    throw tooLong(probe.durationSeconds);
  }

  await progress(55, "Generating thumbnail");
  const thumbnailPath = work.file("thumb.jpg");
  // Grab a frame ~10% in, clamped away from the very start
  const thumbAt = Math.max(1, Math.min(probe.durationSeconds * 0.1, 60));
  await generateThumbnail(localSource, thumbnailPath, thumbAt);
  const thumbnailKey = `users/${userId}/projects/${projectId}/thumbnails/source.jpg`;
  await uploadFile(thumbnailPath, thumbnailKey, "image/jpeg");

  let audioKey: string | null = null;
  if (probe.hasAudio) {
    await progress(75, "Extracting audio track");
    const audioPath = work.file("audio.m4a");
    await extractAudio(localSource, audioPath);
    audioKey = `users/${userId}/projects/${projectId}/audio/source.m4a`;
    await uploadFile(audioPath, audioKey, "audio/mp4");
  }

  await progress(90, "Saving source details");
  await prisma.videoSource.update({
    where: { projectId },
    data: {
      duration: probe.durationSeconds,
      width: probe.width,
      height: probe.height,
      fps: probe.fps,
      sizeBytes: BigInt(size),
      thumbnailKey,
      audioKey,
      title: path.basename(storageKey),
    },
  });
}

async function importYouTube(
  projectId: string,
  videoId: string | null,
  progress: Progress,
): Promise<void> {
  if (!videoId) throw new Error("YouTube source has no video id");
  const prisma = getPrismaClient();

  await progress(30, "Fetching video details");
  const info = await fetchYouTubeInfo(videoId);
  if (info.durationSeconds === null || info.durationSeconds <= 0) {
    throw new Error(
      "Could not determine the video length — live streams and premieres aren't supported",
    );
  }
  if (info.durationSeconds > MAX_SOURCE_DURATION_SECONDS) {
    throw tooLong(info.durationSeconds);
  }

  await progress(85, "Saving video details");
  await prisma.videoSource.update({
    where: { projectId },
    data: {
      title: info.title ?? `YouTube ${videoId}`,
      thumbnailUrl: info.thumbnailUrl,
      duration: info.durationSeconds,
      width: info.width,
      height: info.height,
      fps: info.fps,
    },
  });
}

function tooLong(durationSeconds: number): Error {
  return new Error(
    `Video is too long (${Math.round(durationSeconds / 60)} min, max ${MAX_SOURCE_DURATION_SECONDS / 60} min)`,
  );
}
