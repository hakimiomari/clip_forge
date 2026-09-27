import type { Job } from "bullmq";
import { getPrismaClient } from "@clipforge/database";
import type { Prisma } from "@clipforge/database";
import {
  GENERATED_ENGINES,
  GENERATED_STYLES,
  GENERATED_VIDEO_CREDITS,
  pickGeneratedEngine,
  type GeneratedEngine,
  type GeneratedFormat,
  type GeneratedVideoJob,
} from "@clipforge/shared-types";
import { createWorkDir } from "../lib/media";
import { uploadFile } from "../lib/storage";
import { refundCredits } from "../lib/credits";
import { generateShot } from "../lib/generate/engines";
import { renderShot } from "../lib/generate/assemble";
import { planShotsForVideo } from "../lib/generate/shots";
import { grabThumbnail, joinScenes } from "../lib/research/assemble";
import { probeDuration } from "../lib/research/narration";

/**
 * Shots generated at once. Hosted video models rate-limit per key, and
 * the free image service queues exactly one request per address and
 * refuses a second outright — so everything runs one shot at a time.
 */
const SHOT_CONCURRENCY: Record<GeneratedEngine, number> = { veo: 1, sora: 1, images: 1 };

/** A stable per-shot seed, so rebuilding the same video draws the same pictures. */
function seedFor(id: string, index: number): number {
  const hash = Array.from(id).reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  return (hash + index * 101) % 2_147_483_647;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) {
        results[i] = await task(items[i]!);
      }
    }),
  );
  return results;
}

/**
 * generated-video: a prompt becomes a video of generated shots.
 *
 * Plans the shots, has the configured engine make each one, fits them
 * to the chosen frame and joins them. The shots used are stored on the
 * row so the result can be traced back to the prompts that made it.
 */
export async function processGeneratedVideo(job: Job<GeneratedVideoJob>): Promise<void> {
  const { generatedId, userId } = job.data;
  const prisma = getPrismaClient();

  const record = await prisma.researchVideo.findUnique({ where: { id: generatedId } });
  if (!record || record.userId !== userId || record.kind !== "GENERATED") {
    throw new Error(`Generated video ${generatedId} not found for user`);
  }

  const setProgress = (progress: number, step: string, status?: string) =>
    prisma.researchVideo.update({
      where: { id: generatedId },
      data: { progress, step, ...(status ? { status: status as never } : {}) },
    });

  const engine = pickGeneratedEngine(process.env);
  const info = GENERATED_ENGINES[engine];
  const format = record.format as GeneratedFormat;
  const work = await createWorkDir(`generate-${generatedId}`);
  try {
    // ── 1. Plan ──────────────────────────────────────────
    await setProgress(5, `Planning shots for ${info.label}`, "BUILDING");
    const shots = await planShotsForVideo(
      record.prompt,
      record.targetSeconds ?? 8,
      engine,
      record.style,
    );
    await prisma.researchVideo.update({
      where: { id: generatedId },
      data: {
        engine,
        title: record.prompt.slice(0, 120),
        scenes: shots as unknown as Prisma.InputJsonValue,
      },
    });

    // ── 2. Generate and fit each shot ────────────────────
    const verb = info.realVideo ? "Generating" : "Drawing";
    let finished = 0;
    const errors: string[] = [];
    const rendered = await mapWithConcurrency(shots, SHOT_CONCURRENCY[engine], async (shot) => {
      try {
        await setProgress(
          10 + Math.round((finished / shots.length) * 70),
          `${verb} shot ${shot.index + 1} of ${shots.length} with ${info.label}`,
        );
        const rawPath = work.file(`shot-${shot.index}.${info.realVideo ? "mp4" : "jpg"}`);
        const result = await generateShot(engine, {
          prompt: shot.prompt,
          seconds: shot.seconds,
          format,
          outPath: rawPath,
          seed: seedFor(generatedId, shot.index),
        });
        const outPath = work.file(`part-${shot.index}.mp4`);
        await renderShot({
          mediaPath: rawPath,
          isVideo: result.isVideo,
          seconds: shot.seconds,
          format,
          outPath,
        });
        return outPath;
      } catch (err) {
        // One refused shot costs its slot, not the video — unless every
        // shot fails, when the first reason is the one to show
        const message = err instanceof Error ? err.message : String(err);
        errors.push(message);
        console.warn(`Shot ${shot.index + 1} of ${generatedId} failed: ${message.slice(0, 200)}`);
        return null;
      } finally {
        finished++;
        await setProgress(
          10 + Math.round((finished / shots.length) * 70),
          `Finished ${finished} of ${shots.length} shots`,
        ).catch(() => undefined);
      }
    });
    const parts = rendered.filter((p): p is string => typeof p === "string");
    if (parts.length === 0) {
      throw new Error(errors[0] ?? "No shots could be generated");
    }

    // ── 3. Join and store ────────────────────────────────
    await setProgress(85, "Joining the shots", "RENDERING");
    const finalPath = work.file("generated.mp4");
    await joinScenes(parts, finalPath, work.dir);
    const duration = await probeDuration(finalPath).catch(() =>
      shots.reduce((sum, s) => sum + s.seconds, 0),
    );

    await setProgress(94, "Saving the video");
    const storageKey = `users/${userId}/generated/${generatedId}.mp4`;
    await uploadFile(finalPath, storageKey, "video/mp4");

    let thumbnailKey: string | null = null;
    try {
      const thumbPath = work.file("thumb.jpg");
      await grabThumbnail(finalPath, thumbPath, Math.min(2, duration / 2));
      thumbnailKey = `users/${userId}/generated/${generatedId}.jpg`;
      await uploadFile(thumbPath, thumbnailKey, "image/jpeg");
    } catch {
      // A missing thumbnail is cosmetic
    }

    const styleLabel =
      GENERATED_STYLES.find((s) => s.value === record.style)?.label ?? record.style;
    const notes = [
      record.prompt,
      `Made with ${info.label} · ${parts.length} shot${parts.length === 1 ? "" : "s"} · ${styleLabel}`,
    ];
    if (!info.realVideo) {
      notes.push("The pictures are AI-generated illustrations with camera motion; there is no sound.");
    }
    if (errors.length > 0) {
      notes.push(`${errors.length} shot${errors.length === 1 ? " was" : "s were"} refused and left out.`);
    }
    await prisma.researchVideo.update({
      where: { id: generatedId },
      data: {
        status: "READY",
        progress: 100,
        step: `Done — ${parts.length} shot${parts.length === 1 ? "" : "s"}`,
        description: notes.join("\n\n"),
        storageKey,
        thumbnailKey,
        duration,
        error: null,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    if (isFinalAttempt) {
      await prisma.researchVideo.update({
        where: { id: generatedId },
        data: { status: "FAILED", error: message.slice(0, 1000), step: "Failed" },
      });
      await refundCredits(userId, GENERATED_VIDEO_CREDITS);
    }
    throw err;
  } finally {
    await work.cleanup();
  }
}
