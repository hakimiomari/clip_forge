import type { Job } from "bullmq";
import { getPrismaClient } from "@clipforge/database";
import type { Prisma } from "@clipforge/database";
import {
  buildCompilationCredits,
  chooseMoments,
  COMPILATION_CREDITS,
  MAX_CANDIDATE_VIDEOS,
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
    await setProgress(5, "Searching for videos", "RESEARCHING");
    const candidates = await searchYouTube(record.prompt, MAX_CANDIDATE_VIDEOS);
    if (candidates.length === 0) {
      throw new Error(
        `No usable videos found for "${record.prompt}". Try different words.`,
      );
    }

    // ── 2. Locate the best moments in each ───────────────
    const found: CompilationMoment[] = [];
    for (const [index, candidate] of candidates.entries()) {
      await setProgress(
        10 + Math.round((index / candidates.length) * 35),
        `Analysing ${index + 1} of ${candidates.length}: ${candidate.title.slice(0, 40)}`,
      );
      try {
        found.push(
          ...(await findMoments({
            candidate,
            workDir: work.dir,
            perVideo: MOMENTS_PER_VIDEO,
          })),
        );
      } catch (err) {
        // A video that won't download costs its moments, not the build
        console.warn(
          `Candidate ${candidate.videoId} skipped: ${String(err).slice(0, 160)}`,
        );
      }
    }
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

    // ── 3. Fetch and render each moment ──────────────────
    const parts: string[] = [];
    for (const [index, moment] of moments.entries()) {
      await setProgress(
        45 + Math.round((index / moments.length) * 40),
        `Moment ${index + 1} of ${moments.length}`,
      );
      const sectionPath = work.file(`moment-${index}.mp4`);
      try {
        await downloadYouTubeSection(
          moment.videoId,
          moment.start,
          moment.end,
          sectionPath,
        );
      } catch (err) {
        console.warn(`Moment ${index + 1} unavailable: ${String(err).slice(0, 160)}`);
        continue;
      }
      const renderedPath = work.file(`part-${index}.mp4`);
      await renderMoment({
        inputPath: sectionPath,
        outPath: renderedPath,
        seconds: moment.end - moment.start,
        format: record.format,
        credit: `${moment.channel} — ${moment.videoTitle}`,
      });
      parts.push(renderedPath);
    }
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
