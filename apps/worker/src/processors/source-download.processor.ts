import { stat } from "fs/promises";
import type { Job } from "bullmq";
import { getPrismaClient } from "@clipforge/database";
import type { SourceDownloadJob } from "@clipforge/shared-types";
import { probeVideo } from "../lib/ffmpeg";
import { createWorkDir } from "../lib/media";
import { uploadFile } from "../lib/storage";
import { downloadFullVideo } from "../lib/youtube";

/** Progress writes to the row this often at most — the page polls it. */
const PROGRESS_INTERVAL_MS = 2000;

/**
 * source-download: fetches a YouTube project's complete video so the
 * user can download it. Clips never need this — they fetch only their
 * own sections — so it runs only when asked for, costs no credits, and
 * a failure is recorded on the source without touching the project.
 */
export async function processSourceDownload(job: Job<SourceDownloadJob>): Promise<void> {
  const { projectId, userId } = job.data;
  const prisma = getPrismaClient();

  const source = await prisma.videoSource.findUnique({ where: { projectId } });
  if (!source) throw new Error(`Project ${projectId} has no source`);
  if (source.sourceType !== "YOUTUBE" || !source.externalId) {
    throw new Error("Only a YouTube source needs downloading");
  }

  const setState = (data: {
    downloadStatus?: string;
    downloadProgress?: number;
    downloadError?: string | null;
  }) => prisma.videoSource.updateMany({ where: { projectId }, data });

  const work = await createWorkDir(`full-${projectId}`);
  try {
    await setState({ downloadStatus: "DOWNLOADING", downloadProgress: 0, downloadError: null });

    const outPath = work.file("full.mp4");
    // Roughly realtime is the slowest a healthy download gets; anything
    // past that (or 4 hours) is stuck, not slow
    const timeoutMs = Math.min(
      4 * 60 * 60_000,
      Math.max(20 * 60_000, (source.duration ?? 0) * 1000),
    );
    let lastWrite = 0;
    let lastProgress = -1;
    await downloadFullVideo(source.externalId, outPath, {
      timeoutMs,
      onProgress: (fraction) => {
        const progress = Math.min(99, Math.round(fraction * 100));
        const now = Date.now();
        if (progress === lastProgress || now - lastWrite < PROGRESS_INTERVAL_MS) return;
        lastWrite = now;
        lastProgress = progress;
        void setState({ downloadProgress: progress }).catch(() => undefined);
      },
    });

    await setState({ downloadStatus: "SAVING", downloadProgress: 100 });
    const probe = await probeVideo(outPath);
    const { size } = await stat(outPath);
    const storageKey = `users/${userId}/projects/${projectId}/source/full.mp4`;
    await uploadFile(outPath, storageKey, "video/mp4");

    await prisma.videoSource.updateMany({
      where: { projectId },
      data: {
        downloadKey: storageKey,
        downloadStatus: "READY",
        downloadProgress: 100,
        downloadError: null,
        downloadBytes: BigInt(size),
        downloadWidth: probe.width,
        downloadHeight: probe.height,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    await setState(
      isFinalAttempt
        ? { downloadStatus: "FAILED", downloadError: message.slice(0, 500) }
        : // The retry starts over; say so rather than freeze the bar
          { downloadStatus: "PENDING", downloadProgress: 0 },
    ).catch(() => undefined);
    throw err;
  } finally {
    await work.cleanup();
  }
}
