import { stat } from "fs/promises";
import type { Job } from "bullmq";
import { getPrismaClient } from "@clipforge/database";
import {
  downloadExtension,
  type DownloadQuality,
  type VideoDownloadJob,
} from "@clipforge/shared-types";
import { probeVideo } from "../lib/ffmpeg";
import { createWorkDir } from "../lib/media";
import { deleteObject, uploadFile } from "../lib/storage";
import {
  DownloadCancelledError,
  downloadFullVideo,
  fetchYouTubeInfo,
} from "../lib/youtube";

/** Progress writes to the row this often at most — the page polls it. */
const PROGRESS_INTERVAL_MS = 2000;

/**
 * video-download: a YouTube link saved as a file for the Downloads page,
 * with no project around it. Free, so a failure just records its reason.
 *
 * Deleting the row while this runs is how the user cancels: every write
 * is an updateMany, and one that finds no row stops the download there
 * and then. A file uploaded for a row that is gone is removed again.
 */
export async function processVideoDownload(job: Job<VideoDownloadJob>): Promise<void> {
  const { downloadId, userId } = job.data;
  const prisma = getPrismaClient();

  const record = await prisma.download.findUnique({ where: { id: downloadId } });
  if (!record) return; // deleted before it started
  const quality = record.quality as DownloadQuality;

  const update = (data: Parameters<typeof prisma.download.updateMany>[0]["data"]) =>
    prisma.download.updateMany({ where: { id: downloadId }, data });

  const work = await createWorkDir(`download-${downloadId}`);
  try {
    await update({ status: "DOWNLOADING", progress: 0, error: null });

    // Title and length first: the page shows them while the file comes
    const info = await fetchYouTubeInfo(record.videoId);
    await update({
      title: info.title,
      channel: info.channel,
      duration: info.durationSeconds,
    });

    const outPath = work.file(`video.${downloadExtension(quality)}`);
    // Roughly realtime is the slowest a healthy download gets; anything
    // past that (or 8 hours, for a full test match) is stuck, not slow
    const timeoutMs = Math.min(
      8 * 60 * 60_000,
      Math.max(20 * 60_000, (info.durationSeconds ?? 0) * 1000),
    );
    const cancel = new AbortController();
    let lastWrite = 0;
    let lastProgress = -1;
    await downloadFullVideo(record.videoId, outPath, {
      quality,
      timeoutMs,
      signal: cancel.signal,
      onProgress: (fraction) => {
        const progress = Math.min(99, Math.round(fraction * 100));
        const now = Date.now();
        if (progress === lastProgress || now - lastWrite < PROGRESS_INTERVAL_MS) return;
        lastWrite = now;
        lastProgress = progress;
        void update({ progress })
          .then(({ count }) => {
            if (count === 0) cancel.abort();
          })
          .catch(() => undefined);
      },
    });

    await update({ status: "SAVING", progress: 100 });
    const { size } = await stat(outPath);
    const probe = quality === "audio" ? null : await probeVideo(outPath).catch(() => null);
    const ext = downloadExtension(quality);
    const storageKey = `users/${userId}/downloads/${downloadId}.${ext}`;
    await uploadFile(outPath, storageKey, ext === "m4a" ? "audio/mp4" : "video/mp4");

    const { count } = await update({
      status: "READY",
      progress: 100,
      error: null,
      storageKey,
      sizeBytes: BigInt(size),
      width: probe?.width ?? null,
      height: probe?.height ?? null,
    });
    if (count === 0) {
      // Deleted while downloading — don't leave the file behind
      await deleteObject(storageKey).catch(() => undefined);
    }
  } catch (err) {
    // Cancelled by the user: nothing to record, nothing to retry
    if (err instanceof DownloadCancelledError) return;
    const message = err instanceof Error ? err.message : String(err);
    const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    await update(
      isFinalAttempt
        ? { status: "FAILED", error: message.slice(0, 500) }
        : // The retry starts over; say so rather than freeze the bar
          { status: "PENDING", progress: 0 },
    ).catch(() => undefined);
    throw err;
  } finally {
    await work.cleanup();
  }
}
