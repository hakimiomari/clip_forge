import type { Job } from "bullmq";
import { getPrismaClient } from "@clipforge/database";
import type { Prisma } from "@clipforge/database";
import {
  buildCompilationCredits,
  chooseMoments,
  COMPILATION_CREDITS,
  MAX_CANDIDATE_VIDEOS,
  MOMENT_SECONDS,
  type CompilationFreshness,
  type CompilationJob,
  type CompilationMoment,
} from "@clipforge/shared-types";
import { createWorkDir } from "../lib/media";
import { uploadFile } from "../lib/storage";
import { refundCredits } from "../lib/credits";
import { downloadYouTubeSection } from "../lib/youtube";
import { searchYouTube } from "../lib/compile/search";
import { findMoments } from "../lib/compile/moments";
import { joinMoments, renderMoment } from "../lib/compile/assemble";
import { grabThumbnail } from "../lib/research/assemble";
import { probeDuration } from "../lib/research/narration";

/** Moments taken from each video before moving to the next one. */
const MOMENTS_PER_VIDEO = 2;
/**
 * Candidates analysed at once. The work is mostly waiting on YouTube, so
 * three in flight is close to three times faster; more starts earning
 * rate limits.
 */
const ANALYSIS_CONCURRENCY = 3;
/**
 * One slow video (a huge match with no replay heatmap on a slow link)
 * shouldn't hold up the rest — past this it is skipped.
 */
const CANDIDATE_TIMEOUT_MS = 4 * 60_000;
/**
 * The whole-video audio download inside that budget is killed at this
 * point rather than merely abandoned — an abandoned yt-dlp would keep
 * downloading and slow every other candidate down with it. Leaves a
 * minute for scoring.
 */
const CANDIDATE_DOWNLOAD_TIMEOUT_MS = 3 * 60_000;
/**
 * Moments fetched and encoded at once. Two, not three: each encode holds
 * a 1080x1920 frame pipeline in memory, and this machine has hit render
 * out-of-memory errors before.
 */
const RENDER_CONCURRENCY = 2;

function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} took longer than ${ms / 60_000} min`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Runs `task` over `items` with at most `limit` in flight at once. Once
 * `enough()` returns true no new items are started; their slots stay
 * undefined.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
  enough: () => boolean = () => false,
): Promise<(R | undefined)[]> {
  const results: (R | undefined)[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length && !enough(); i = next++) {
      results[i] = await task(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * compilation: one prompt becomes a best-of video.
 *
 * Searches YouTube, analyses each candidate's audio to locate its
 * strongest moments, fetches only those windows, and joins them into a
 * single video of the requested length. Every moment used is stored
 * with its source video and timestamp so the result can be traced back.
 */
export async function processCompilation(job: Job<CompilationJob>): Promise<void> {
  const { compilationId, userId } = job.data;
  const prisma = getPrismaClient();

  const record = await prisma.researchVideo.findUnique({
    where: { id: compilationId },
  });
  if (!record || record.userId !== userId) {
    throw new Error(`Compilation ${compilationId} not found for user`);
  }

  const setProgress = (progress: number, step: string, status?: string) =>
    prisma.researchVideo.update({
      where: { id: compilationId },
      data: { progress, step, ...(status ? { status: status as never } : {}) },
    });

  const targetSeconds = record.targetSeconds ?? 60;
  const work = await createWorkDir(`compile-${compilationId}`);
  try {
    // ── 1. Find candidates ───────────────────────────────
    const freshness = (record.freshness ?? "mix") as CompilationFreshness;
    await setProgress(
      5,
      freshness === "latest"
        ? "Searching the latest uploads"
        : freshness === "mix"
          ? "Searching classic and recent videos"
          : "Searching for videos",
      "RESEARCHING",
    );
    const candidates = await searchYouTube(record.prompt, MAX_CANDIDATE_VIDEOS, freshness);
    if (candidates.length === 0) {
      throw new Error(
        freshness === "latest"
          ? `No recent uploads found for "${record.prompt}". Try "Mix" or different words.`
          : `No usable videos found for "${record.prompt}". Try different words.`,
      );
    }

    // ── 2. Locate the best moments in each, several at once ──
    // One moment per video fills the target with the most variety, so
    // once that many videos have produced moments, the rest of the list
    // (lower in the search ranking anyway) isn't worth analysing
    const videosNeeded = Math.ceil(targetSeconds / MOMENT_SECONDS);
    let videosWithMoments = 0;
    let finished = 0;
    const perCandidate = await mapWithConcurrency(
      candidates,
      ANALYSIS_CONCURRENCY,
      async (candidate) => {
        try {
          return await withTimeout(
            findMoments({
              candidate,
              workDir: work.dir,
              perVideo: MOMENTS_PER_VIDEO,
              downloadTimeoutMs: CANDIDATE_DOWNLOAD_TIMEOUT_MS,
            }).then((moments) => {
              if (moments.length > 0) videosWithMoments++;
              return moments;
            }),
            CANDIDATE_TIMEOUT_MS,
            candidate.videoId,
          );
        } catch (err) {
          // A video that won't download costs its moments, not the build
          console.warn(
            `Candidate ${candidate.videoId} skipped: ${String(err).slice(0, 160)}`,
          );
          return [];
        } finally {
          finished++;
          await setProgress(
            10 + Math.round((finished / candidates.length) * 35),
            `Analysed ${finished} of ${candidates.length} videos`,
          ).catch(() => undefined);
        }
      },
      () => videosWithMoments >= videosNeeded,
    );
    const found: CompilationMoment[] = perCandidate.flatMap((m) => m ?? []);
    if (found.length === 0) {
      throw new Error(
        "Found videos but none could be analysed — they may be region-locked or unavailable.",
      );
    }

    const moments = chooseMoments(found, targetSeconds);
    await prisma.researchVideo.update({
      where: { id: compilationId },
      data: {
        title: record.prompt,
        description: `${record.prompt}\n\nClips used:\n${buildCompilationCredits(moments)}`,
        scenes: moments as unknown as Prisma.InputJsonValue,
        status: "BUILDING",
        progress: 45,
        step: `Fetching ${moments.length} moments`,
      },
    });

    // ── 3. Fetch and render the moments, two at a time ────
    // Independent of each other, so they overlap: one downloads while
    // another encodes. Results keep the chosen order for the final cut.
    let built = 0;
    const rendered = await mapWithConcurrency(
      moments,
      RENDER_CONCURRENCY,
      async (moment, index) => {
        const sectionPath = work.file(`moment-${index}.mp4`);
        try {
          await downloadYouTubeSection(
            moment.videoId,
            moment.start,
            moment.end,
            sectionPath,
          );
          const renderedPath = work.file(`part-${index}.mp4`);
          await renderMoment({
            inputPath: sectionPath,
            outPath: renderedPath,
            seconds: moment.end - moment.start,
            format: record.format,
            credit: `${moment.channel} — ${moment.videoTitle}`,
          });
          return renderedPath;
        } catch (err) {
          // One unavailable moment costs its slot, not the compilation
          console.warn(`Moment ${index + 1} unavailable: ${String(err).slice(0, 160)}`);
          return null;
        } finally {
          built++;
          await setProgress(
            45 + Math.round((built / moments.length) * 40),
            `Built ${built} of ${moments.length} moments`,
          ).catch(() => undefined);
        }
      },
    );
    const parts = rendered.filter((p): p is string => typeof p === "string");
    if (parts.length === 0) {
      throw new Error("None of the chosen moments could be downloaded.");
    }

    // ── 4. Join and store ────────────────────────────────
    await setProgress(88, "Joining the moments", "RENDERING");
    const finalPath = work.file("compilation.mp4");
    await joinMoments(parts, finalPath, work.dir);
    const duration = await probeDuration(finalPath).catch(
      () => moments.reduce((sum, m) => sum + (m.end - m.start), 0),
    );

    await setProgress(94, "Saving the video");
    const storageKey = `users/${userId}/compilations/${compilationId}.mp4`;
    await uploadFile(finalPath, storageKey, "video/mp4");

    let thumbnailKey: string | null = null;
    try {
      const thumbPath = work.file("thumb.jpg");
      await grabThumbnail(finalPath, thumbPath, Math.min(2, duration / 2));
      thumbnailKey = `users/${userId}/compilations/${compilationId}.jpg`;
      await uploadFile(thumbPath, thumbnailKey, "image/jpeg");
    } catch {
      // A missing thumbnail is cosmetic
    }

    await prisma.researchVideo.update({
      where: { id: compilationId },
      data: {
        status: "READY",
        progress: 100,
        step: `Done — ${parts.length} moments`,
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
        where: { id: compilationId },
        data: { status: "FAILED", error: message.slice(0, 1000), step: "Failed" },
      });
      await refundCredits(userId, COMPILATION_CREDITS);
    }
    throw err;
  } finally {
    await work.cleanup();
  }
}
