import type { Job } from "bullmq";
import { getPrismaClient } from "@clipforge/database";
import type { Prisma } from "@clipforge/database";
import {
  RESEARCH_VIDEO_CREDITS,
  type ResearchFormat,
  type ResearchVideoJob,
} from "@clipforge/shared-types";
import { createWorkDir } from "../lib/media";
import { probeVideo } from "../lib/ffmpeg";
import { uploadFile } from "../lib/storage";
import { refundCredits } from "../lib/credits";
import { findArticle, findImages, findVideos } from "../lib/research/sources";
import { buildAttribution, buildResearchPlan } from "../lib/research/plan";
import { narrationAvailable, probeDuration, speak } from "../lib/research/narration";
import {
  fetchMedia,
  grabThumbnail,
  joinScenes,
  renderScene,
} from "../lib/research/assemble";
import {
  CARTOON_LONG_EDGE,
  IMAGE_LONG_EDGE,
  probePixelSize,
  stylizeImage,
  stylizeVideo,
  type CartoonStyle,
} from "../lib/cartoon";
import { RESEARCH_RESOLUTIONS } from "../lib/research/assemble";

/** Enough to say something, short enough to hold attention. */
const MAX_SCENES = 8;
/** Wikimedia rate-limits bursts; a short gap keeps us under it. */
const MEDIA_GAP_MS = 400;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Downloads one file, backing off once if Commons rate-limits us —
 * a burst of eight downloads reliably earns a 429 otherwise.
 */
async function fetchMediaPolitely(
  url: string,
  target: string,
  index: number,
): Promise<string> {
  if (index > 0) await sleep(MEDIA_GAP_MS);
  try {
    await fetchMedia(url, target);
  } catch (err) {
    if (!/HTTP 429/.test(String(err))) throw err;
    await sleep(3000);
    await fetchMedia(url, target);
  }
  return target;
}

/**
 * research-video: turns a topic into a finished video.
 *
 * Facts come from Wikipedia and every picture or clip from Wikimedia
 * Commons, so the result is built entirely from openly-licensed
 * material and each scene keeps the attribution it needs. Narration
 * uses the machine's own voice where one exists; otherwise the
 * captions carry the words.
 */
export async function processResearchVideo(job: Job<ResearchVideoJob>): Promise<void> {
  const { researchId, userId } = job.data;
  const prisma = getPrismaClient();

  const record = await prisma.researchVideo.findUnique({ where: { id: researchId } });
  if (!record || record.userId !== userId) {
    throw new Error(`Research video ${researchId} not found for user`);
  }

  const setProgress = (progress: number, step: string, status?: string) =>
    prisma.researchVideo.update({
      where: { id: researchId },
      data: { progress, step, ...(status ? { status: status as never } : {}) },
    });

  const work = await createWorkDir(`research-${researchId}`);
  try {
    // ── 1. Research ──────────────────────────────────────
    await setProgress(5, "Looking up the topic", "RESEARCHING");
    const article = await findArticle(record.prompt);
    if (!article) {
      throw new Error(
        `Nothing found for "${record.prompt}". Try a more specific topic, ` +
          `or the name of a person, place or event.`,
      );
    }

    await setProgress(15, `Collecting pictures about ${article.title}`);
    // Search the article's own title: it is the canonical name and
    // returns far better media than a loose prompt
    const [images, videos] = await Promise.all([
      findImages(article.title, MAX_SCENES).catch(() => []),
      findVideos(article.title, 2).catch(() => []),
    ]);

    const plan = buildResearchPlan({ article, images, videos, maxScenes: MAX_SCENES });
    if (plan.scenes.length === 0) {
      throw new Error(
        `Found the article for "${article.title}" but no usable sentences in it.`,
      );
    }

    await prisma.researchVideo.update({
      where: { id: researchId },
      data: {
        title: plan.title,
        description: `${plan.summary}\n\n${buildAttribution(plan)}`,
        scenes: plan.scenes as unknown as Prisma.InputJsonValue,
        status: "BUILDING",
        progress: 25,
        step: `Building ${plan.scenes.length} scenes`,
      },
    });

    // ── 2. Scenes ────────────────────────────────────────
    const format = (record.format as ResearchFormat) ?? "vertical";
    const cartoonStyle =
      record.cartoonStyle && record.cartoonStyle !== "none"
        ? (record.cartoonStyle as CartoonStyle)
        : null;
    const canNarrate = narrationAvailable();
    const scenePaths: string[] = [];
    let totalSeconds = 0;

    for (const [index, scene] of plan.scenes.entries()) {
      const share = 25 + Math.round((index / plan.scenes.length) * 55);
      await setProgress(share, `Scene ${index + 1} of ${plan.scenes.length}`);

      // Media: a failed download costs one scene's picture, not the video
      let mediaPath: string | null = null;
      let isVideo = false;
      if (scene.media) {
        const ext = scene.media.kind === "video" ? ".media" : ".img";
        const target = work.file(`scene-${index}${ext}`);
        try {
          mediaPath = await fetchMediaPolitely(scene.media.sourceUrl, target, index);
          isVideo = scene.media.kind === "video";
        } catch (err) {
          console.warn(`Scene ${index + 1} media unavailable: ${String(err).slice(0, 160)}`);
        }
      }

      // Narration sets the scene's length, so the words are never cut off
      let audioPath: string | null = null;
      let seconds = scene.seconds;
      if (canNarrate) {
        try {
          const target = work.file(`narration-${index}.m4a`);
          const spoken = await speak({
            text: scene.text,
            outPath: target,
            workDir: work.dir,
            index,
          });
          audioPath = target;
          seconds = spoken + 0.6;
        } catch (err) {
          console.warn(`Scene ${index + 1} narration failed: ${String(err).slice(0, 160)}`);
        }
      }

      // Cartoon look: the picture itself is stylized, so the caption and
      // credits drawn over it stay sharp. A still costs one inference; a
      // clip costs one per frame, which is why stills stay at full
      // quality and clips drop to the smaller model size.
      if (cartoonStyle && mediaPath) {
        try {
          await setProgress(
            share,
            `Drawing scene ${index + 1} of ${plan.scenes.length}`,
          );
          if (isVideo) {
            const size = await probePixelSize(mediaPath);
            const keepsOwnSound =
              !audioPath &&
              (await probeVideo(mediaPath).then((p) => p.hasAudio, () => false));
            const styled = work.file(`scene-${index}-cartoon.mp4`);
            await stylizeVideo({
              inputPath: mediaPath,
              start: 0,
              duration: seconds,
              outPath: styled,
              style: cartoonStyle,
              sourceWidth: size.width,
              sourceHeight: size.height,
              longEdge: CARTOON_LONG_EDGE.standard,
              hasAudio: keepsOwnSound,
            });
            mediaPath = styled;
          } else {
            const styled = work.file(`scene-${index}-cartoon.png`);
            await stylizeImage({
              inputPath: mediaPath,
              outPath: styled,
              style: cartoonStyle,
              // The picture is scaled into the frame anyway, so there is
              // nothing to gain from running the model above frame width
              longEdge: Math.min(
                IMAGE_LONG_EDGE,
                RESEARCH_RESOLUTIONS[format].width,
              ),
            });
            mediaPath = styled;
          }
        } catch (err) {
          // A picture that will not stylize still belongs in the video
          console.warn(
            `Scene ${index + 1} cartoon failed, using the original: ${String(err).slice(0, 160)}`,
          );
        }
      }

      const scenePath = work.file(`scene-${index}.mp4`);
      await renderScene({
        mediaPath,
        isVideo,
        text: scene.text,
        seconds,
        audioPath,
        outPath: scenePath,
        workDir: work.dir,
        index,
        format,
      });
      scenePaths.push(scenePath);
      totalSeconds += seconds;
    }

    // ── 3. Join and store ────────────────────────────────
    await setProgress(85, "Joining the scenes", "RENDERING");
    const finalPath = work.file("research.mp4");
    await joinScenes(scenePaths, finalPath, work.dir);
    const duration = await probeDuration(finalPath).catch(() => totalSeconds);

    await setProgress(92, "Saving the video");
    const storageKey = `users/${userId}/research/${researchId}.mp4`;
    await uploadFile(finalPath, storageKey, "video/mp4");

    let thumbnailKey: string | null = null;
    try {
      const thumbPath = work.file("thumb.jpg");
      await grabThumbnail(finalPath, thumbPath, Math.min(2, duration / 2));
      thumbnailKey = `users/${userId}/research/${researchId}.jpg`;
      await uploadFile(thumbPath, thumbnailKey, "image/jpeg");
    } catch {
      // A missing thumbnail is cosmetic
    }

    await prisma.researchVideo.update({
      where: { id: researchId },
      data: {
        status: "READY",
        progress: 100,
        step: `Done — ${plan.scenes.length} scenes`,
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
        where: { id: researchId },
        data: { status: "FAILED", error: message.slice(0, 1000), step: "Failed" },
      });
      await refundCredits(userId, RESEARCH_VIDEO_CREDITS);
    }
    throw err;
  } finally {
    await work.cleanup();
  }
}

export { MAX_SCENES };
