import type { Job } from "bullmq";
import { mkdir, rm, stat } from "fs/promises";
import os from "os";
import path from "path";
import { getPrismaClient } from "@clipforge/database";
import type { VideoImportJob } from "@clipforge/shared-types";
import { extractAudio, generateThumbnail, probeVideo } from "../lib/ffmpeg";
import { downloadToFile, uploadFile } from "../lib/storage";
import { publishProgress } from "../lib/progress";
import { env } from "../env";

const MAX_SOURCE_DURATION_SECONDS = 4 * 60 * 60; // 4 hours

/**
 * video-import: turns an attached source into a fully described,
 * processing-ready VideoSource.
 *
 *  UPLOAD  → download from storage, ffprobe metadata, thumbnail,
 *            extract transcription audio, mark IMPORTED.
 *  YOUTUBE → fetch compliant metadata (oEmbed / Data API). ClipForge
 *            does not download YouTube media; processing continues
 *            when the user uploads media they are authorized to use.
 */
export async function processVideoImport(
  job: Job<VideoImportJob>,
): Promise<void> {
  const { projectId, userId } = job.data;
  const prisma = getPrismaClient();

  const progress = (progressPct: number, step: string) =>
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

  try {
    if (project.source.sourceType === "UPLOAD") {
      await importUpload(projectId, userId, project.source.storageKey, progress);
    } else if (project.source.sourceType === "YOUTUBE") {
      await importYouTubeMetadata(projectId, project.source.externalId, progress);
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
      await publishProgress({
        projectId,
        status: "FAILED",
        progress: 0,
        step: "Import failed",
        error: message,
      });
    }
    throw err;
  }
}

async function importUpload(
  projectId: string,
  userId: string,
  storageKey: string | null,
  progress: (progressPct: number, step: string) => Promise<void>,
): Promise<void> {
  if (!storageKey) throw new Error("Upload source has no storage key");
  const prisma = getPrismaClient();

  const workDir = path.join(os.tmpdir(), "clipforge", projectId);
  await mkdir(workDir, { recursive: true });
  const localSource = path.join(workDir, "source" + path.extname(storageKey));

  try {
    await progress(10, "Downloading uploaded video");
    await downloadToFile(storageKey, localSource);
    const { size } = await stat(localSource);

    await progress(35, "Reading video metadata");
    const probe = await probeVideo(localSource);
    if (probe.durationSeconds > MAX_SOURCE_DURATION_SECONDS) {
      throw new Error(
        `Video is too long (${Math.round(probe.durationSeconds / 60)} min, max ${MAX_SOURCE_DURATION_SECONDS / 60} min)`,
      );
    }

    await progress(55, "Generating thumbnail");
    const thumbnailPath = path.join(workDir, "thumb.jpg");
    // Grab a frame ~10% in, clamped away from the very start
    const thumbAt = Math.max(1, Math.min(probe.durationSeconds * 0.1, 60));
    await generateThumbnail(localSource, thumbnailPath, thumbAt);
    const thumbnailKey = `users/${userId}/projects/${projectId}/thumbnails/source.jpg`;
    await uploadFile(thumbnailPath, thumbnailKey, "image/jpeg");

    let audioKey: string | null = null;
    if (probe.hasAudio) {
      await progress(75, "Extracting audio track");
      const audioPath = path.join(workDir, "audio.m4a");
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
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

interface OEmbedResponse {
  title?: string;
  author_name?: string;
  thumbnail_url?: string;
}

async function importYouTubeMetadata(
  projectId: string,
  videoId: string | null,
  progress: (progressPct: number, step: string) => Promise<void>,
): Promise<void> {
  if (!videoId) throw new Error("YouTube source has no video id");
  const prisma = getPrismaClient();

  await progress(30, "Fetching video details");
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`;
  const response = await fetch(oembedUrl);
  if (!response.ok) {
    throw new Error(
      `Could not retrieve video details (${response.status}). The video may be private or unavailable.`,
    );
  }
  const meta = (await response.json()) as OEmbedResponse;

  // Duration requires the Data API — optional, keyed via env
  let duration: number | null = null;
  if (env.YOUTUBE_API_KEY) {
    await progress(60, "Fetching video duration");
    try {
      const apiUrl = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${videoId}&key=${env.YOUTUBE_API_KEY}`;
      const apiRes = await fetch(apiUrl);
      if (apiRes.ok) {
        const data = (await apiRes.json()) as {
          items?: Array<{ contentDetails?: { duration?: string } }>;
        };
        const iso = data.items?.[0]?.contentDetails?.duration;
        if (iso) duration = parseIsoDuration(iso);
      }
    } catch {
      // Duration is a nice-to-have; metadata import proceeds without it.
    }
  }

  await progress(85, "Saving video details");
  await prisma.videoSource.update({
    where: { projectId },
    data: {
      title: meta.title ?? null,
      thumbnailUrl: meta.thumbnail_url ?? null,
      duration,
    },
  });
}

/** Parses ISO-8601 durations like PT1H2M3S. */
export function parseIsoDuration(iso: string): number | null {
  const match = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return null;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  return hours * 3600 + minutes * 60 + seconds;
}
