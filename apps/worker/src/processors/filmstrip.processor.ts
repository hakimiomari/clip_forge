import type { Job } from "bullmq";
import { getPrismaClient } from "@clipforge/database";
import type { FilmstripJob } from "@clipforge/shared-types";
import { buildFilmstrip, planFilmstrip } from "../lib/filmstrip";
import { createWorkDir } from "../lib/media";
import { presignGetUrl, uploadFile } from "../lib/storage";
import { resolveYouTubeStreams } from "../lib/youtube";

/**
 * filmstrip: builds the sprite sheet of source frames shown behind the
 * timeline so users can see what they are selecting.
 *
 * Costs no credits and never blocks the project: a failure is recorded
 * on the source and the editor falls back to a plain timeline.
 */
export async function processFilmstrip(job: Job<FilmstripJob>): Promise<void> {
  const { projectId, userId } = job.data;
  const prisma = getPrismaClient();

  const source = await prisma.videoSource.findUnique({ where: { projectId } });
  if (!source) throw new Error(`Project ${projectId} has no source`);
  if (!source.duration || source.duration <= 0) {
    throw new Error("Source duration is unknown — import must finish first");
  }

  const geometry = planFilmstrip(source.duration);
  const work = await createWorkDir(`strip-${projectId}`);
  try {
    // YouTube media is never stored: read frames from the low-res CDN
    // stream. Uploads are seeked over a presigned URL, so a multi-GB
    // object costs a few range requests instead of a full download.
    let input: string;
    if (source.storageKey) {
      input = await presignGetUrl(source.storageKey);
    } else if (source.sourceType === "YOUTUBE" && source.externalId) {
      const streams = await resolveYouTubeStreams(source.externalId);
      input = streams.videoUrl ?? streams.audioUrl;
    } else {
      throw new Error("Source has no readable media");
    }

    const spritePath = work.file("filmstrip.jpg");
    await buildFilmstrip({
      input,
      workDir: work.dir,
      outputPath: spritePath,
      geometry,
      onProgress: (done, total) => {
        if (done % 10 === 0 || done === total) {
          void job.updateProgress(Math.round((done / total) * 100)).catch(() => undefined);
        }
      },
    });

    const storageKey = `users/${userId}/projects/${projectId}/filmstrip/strip.jpg`;
    await uploadFile(spritePath, storageKey, "image/jpeg");

    await prisma.videoSource.update({
      where: { projectId },
      data: {
        filmstripKey: storageKey,
        filmstripStatus: "READY",
        filmstripCount: geometry.count,
        filmstripColumns: geometry.columns,
        filmstripFrameWidth: geometry.frameWidth,
        filmstripFrameHeight: geometry.frameHeight,
        filmstripError: null,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    if (isFinalAttempt) {
      await prisma.videoSource.updateMany({
        where: { projectId },
        data: { filmstripStatus: "FAILED", filmstripError: message.slice(0, 500) },
      });
    }
    throw err;
  } finally {
    await work.cleanup();
  }
}
