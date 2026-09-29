import { stat } from "fs/promises";
import type { Job } from "bullmq";
import { getPrismaClient } from "@clipforge/database";
import type { Prisma } from "@clipforge/database";
import {
  evenPhotoTimes,
  photoStamp,
  pickSceneTimes,
  type PhotoPickMode,
  type StoredPhoto,
  type VideoPhotosJob,
} from "@clipforge/shared-types";
import { probeVideo } from "../lib/ffmpeg";
import { createWorkDir } from "../lib/media";
import { detectSceneCuts, grabPhoto, writeStoreZip } from "../lib/photos";
import { deleteObject, uploadFile } from "../lib/storage";
import {
  downloadLowResVideo,
  fetchYouTubeInfo,
  resolveBestVideoUrl,
} from "../lib/youtube";

/** Photos grabbed at once — each is a short seek-and-decode against the CDN. */
const GRAB_CONCURRENCY = 4;
const PROGRESS_INTERVAL_MS = 1500;

class Cancelled extends Error {}

/**
 * video-photos: a YouTube link becomes a set of stills spread across the
 * video, plus one ZIP of them all. Free, and no project is made.
 *
 * Deleting the row is how the user cancels: every progress write is an
 * updateMany, and one that finds no row stops the job; anything already
 * uploaded is removed again.
 */
export async function processVideoPhotos(job: Job<VideoPhotosJob>): Promise<void> {
  const { photoSetId, userId } = job.data;
  const prisma = getPrismaClient();

  const record = await prisma.photoSet.findUnique({ where: { id: photoSetId } });
  if (!record) return; // deleted before it started
  const mode = record.mode as PhotoPickMode;

  let lastWrite = 0;
  const update = async (
    data: Prisma.PhotoSetUpdateManyMutationInput,
    { force = true } = {},
  ) => {
    const now = Date.now();
    if (!force && now - lastWrite < PROGRESS_INTERVAL_MS) return;
    lastWrite = now;
    const { count } = await prisma.photoSet.updateMany({ where: { id: photoSetId }, data });
    if (count === 0) throw new Cancelled();
  };

  const work = await createWorkDir(`photos-${photoSetId}`);
  const uploaded: string[] = [];
  try {
    await update({ status: "FINDING", progress: 2, step: "Reading the video", error: null });
    const info = await fetchYouTubeInfo(record.videoId);
    const duration = info.durationSeconds ?? 0;
    if (duration <= 0) throw new Error("YouTube didn't say how long this video is");
    await update({ title: info.title, channel: info.channel, duration });

    // ── 1. When to take each photo ───────────────────────
    let times: number[];
    if (mode === "scenes") {
      await update({ progress: 5, step: "Scanning for the best shots" });
      const lowRes = work.file("scan.mp4");
      await downloadLowResVideo(record.videoId, lowRes, {
        timeoutMs: Math.max(10 * 60_000, duration * 500),
        onProgress: (f) =>
          void update(
            { progress: 5 + Math.round(f * 25), step: `Scanning for the best shots (${Math.round(f * 100)}%)` },
            { force: false },
          ).catch(() => undefined),
      });
      await update({ progress: 32, step: "Finding scene changes" });
      const cuts = await detectSceneCuts(lowRes, duration);
      times = pickSceneTimes(cuts, duration, record.count);
    } else {
      times = evenPhotoTimes(duration, record.count);
    }

    // ── 2. Grab each photo at full quality ───────────────
    await update({ status: "CAPTURING", progress: 40, step: `Taking ${times.length} photos` });
    let streamUrl = await resolveBestVideoUrl(record.videoId);
    // Signed stream URLs expire and YouTube stalls the odd read. Up to
    // three tries: each retry on a fresh URL, a moment either side of the
    // chosen time (a neighbouring frame of the same shot is as good), so
    // one bad stretch of the stream doesn't cost the photo
    const grabWithRetry = async (time: number, path: string): Promise<boolean> => {
      const tries = [0, 1.5, -1.5];
      for (const [attempt, shift] of tries.entries()) {
        try {
          if (attempt > 0) streamUrl = await resolveBestVideoUrl(record.videoId);
          await grabPhoto(streamUrl, Math.max(0, time + shift), path);
          return true;
        } catch (err) {
          if (attempt === tries.length - 1) {
            console.warn(`Photo at ${time}s of ${record.videoId} skipped: ${String(err).slice(0, 160)}`);
          }
        }
      }
      return false;
    };
    const grabbed: Array<{ index: number; time: number; path: string } | null> = new Array(times.length).fill(null);
    let done = 0;
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(GRAB_CONCURRENCY, times.length) }, async () => {
        for (let i = next++; i < times.length; i = next++) {
          const time = times[i]!;
          const path = work.file(`photo-${String(i + 1).padStart(2, "0")}.jpg`);
          if (await grabWithRetry(time, path)) grabbed[i] = { index: i, time, path };
          done++;
          await update(
            {
              progress: 40 + Math.round((done / times.length) * 45),
              step: `Taking photos (${done} of ${times.length})`,
            },
            { force: false },
          );
        }
      }),
    );
    const photos = grabbed.filter((p): p is NonNullable<typeof p> => p !== null);
    if (photos.length === 0) {
      throw new Error("No photos could be taken from this video — try again in a minute");
    }

    // ── 3. Store them, and one ZIP of the lot ────────────
    await update({ status: "SAVING", progress: 88, step: "Saving the photos" });
    const base = `users/${userId}/photos/${photoSetId}`;
    const stored: StoredPhoto[] = [];
    for (const [n, photo] of photos.entries()) {
      const key = `${base}/${String(n + 1).padStart(2, "0")}-${photoStamp(photo.time)}.jpg`;
      const [probe, { size }] = await Promise.all([
        probeVideo(photo.path).catch(() => null),
        stat(photo.path),
      ]);
      await uploadFile(photo.path, key, "image/jpeg");
      uploaded.push(key);
      stored.push({
        index: n,
        time: photo.time,
        key,
        width: probe?.width ?? null,
        height: probe?.height ?? null,
        sizeBytes: size,
      });
    }

    const zipPath = work.file("photos.zip");
    const zipBytes = await writeStoreZip(
      photos.map((p, n) => ({
        path: p.path,
        name: `${String(n + 1).padStart(2, "0")} - ${photoStamp(p.time)}.jpg`,
      })),
      zipPath,
    );
    const zipKey = `${base}/photos.zip`;
    await uploadFile(zipPath, zipKey, "application/zip");
    uploaded.push(zipKey);

    await update({
      status: "READY",
      progress: 100,
      step: `${stored.length} photos`,
      photos: stored as unknown as Prisma.InputJsonValue,
      zipKey,
      zipBytes: BigInt(zipBytes),
    });
  } catch (err) {
    if (err instanceof Cancelled) {
      // Deleted while running — nothing to record; don't leave files behind
      await Promise.all(uploaded.map((key) => deleteObject(key).catch(() => undefined)));
      return;
    }
    await Promise.all(uploaded.map((key) => deleteObject(key).catch(() => undefined)));
    const message = err instanceof Error ? err.message : String(err);
    const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    await prisma.photoSet
      .updateMany({
        where: { id: photoSetId },
        data: isFinalAttempt
          ? { status: "FAILED", error: message.slice(0, 500), step: "Failed" }
          : { status: "PENDING", progress: 0, step: "Retrying" },
      })
      .catch(() => undefined);
    throw err;
  } finally {
    await work.cleanup();
  }
}
