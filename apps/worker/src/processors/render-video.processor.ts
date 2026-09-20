import type { Job } from "bullmq";
import { writeFile, stat } from "fs/promises";
import { getPrismaClient } from "@clipforge/database";
import type { EditingPlan, RenderVideoJob } from "@clipforge/shared-types";
import { planTotalDuration, renderCost } from "@clipforge/shared-types";
import { buildAssDocument, type CaptionLine } from "../lib/captions";
import { createWorkDir, fetchToWorkDir } from "../lib/media";
import { concatParts, type ConcatPart } from "../lib/concat";
import { runRender, type RenderSpec } from "../lib/render";
import { probeVideo } from "../lib/ffmpeg";
import { uploadFile } from "../lib/storage";
import { publishProgress } from "../lib/progress";
import { refundCredits } from "../lib/credits";
import { downloadYouTubeSection } from "../lib/youtube";
import { buildTimeMap } from "../lib/time-map";
import { createGlowSprite } from "../lib/effects";
import { buildCtaAss } from "../lib/cta";
import { generateMaskVideo } from "../lib/bg-removal";

/** Burned into every free-plan render, top-centre. */
const WATERMARK_TEXT = "Powerd by CricPulse";

/**
 * render-video: Rendering Agent + Quality Control Agent.
 * Consumes the clip's editing plan, renders the MP4 with FFmpeg,
 * verifies the output, uploads it and records an Export.
 */
export async function processRenderVideo(job: Job<RenderVideoJob>): Promise<void> {
  const { clipId, renderJobId, userId, chargedCredits } = job.data;
  const prisma = getPrismaClient();

  const clip = await prisma.clip.findUnique({
    where: { id: clipId },
    include: {
      project: { include: { source: true } },
      captions: { orderBy: { index: "asc" } },
    },
  });
  if (!clip || clip.project.userId !== userId) {
    throw new Error(`Clip ${clipId} not found for user`);
  }
  const source = clip.project.source;
  const youtubeId = source?.sourceType === "YOUTUBE" ? source.externalId : null;
  if (!source || (!source.storageKey && !youtubeId)) {
    throw new Error("Source media is missing — cannot render this clip");
  }
  const plan = clip.editingPlan as unknown as EditingPlan | null;
  const segment = plan?.segments?.[0];
  if (!plan || !segment) {
    throw new Error("Clip has no editing plan");
  }
  // A clip may be stitched from several source ranges played in order
  const segments = plan.segments;

  const projectId = clip.projectId;
  const duration = planTotalDuration(plan);
  // AI background removal is incompatible with speed effects (the mask
  // stream can't follow a warped timeline) — strip them defensively.
  const bgRemoval = plan.backgroundRemoval?.enabled ? plan.backgroundRemoval : null;
  const effectiveEffects = bgRemoval
    ? (plan.rangeEffects ?? []).filter(
        (e) => !["slow_motion", "speed_up", "freeze_frame", "speed_ramp"].includes(e.type),
      )
    : plan.rangeEffects;
  // Speed effects (slow motion, freeze…) change the output duration and
  // shift everything downstream of them — captions and QC use this map.
  const timeMap = buildTimeMap(effectiveEffects, duration);
  const outputDuration = timeMap.outputDuration;

  const emit = (progress: number, step: string) =>
    publishProgress({
      projectId,
      clipId,
      status: "RENDERING",
      progress,
      step,
    });

  const updateRenderJob = (data: Record<string, unknown>) =>
    prisma.renderJob.update({ where: { id: renderJobId }, data });

  const work = await createWorkDir(`render-${clipId}`);
  try {
    await prisma.clip.update({
      where: { id: clipId },
      data: { status: "RENDERING" },
    });
    await updateRenderJob({
      status: "RUNNING",
      startedAt: new Date(),
      progress: 2,
      step: "Preparing",
    });
    await emit(2, "Preparing render");

    // Gather each part. For YouTube only the needed windows are fetched,
    // so a stitched clip still never downloads the whole video.
    const partLabel = segments.length > 1 ? ` (${segments.length} parts)` : "";
    let parts: ConcatPart[];
    if (youtubeId) {
      await emit(4, `Fetching clip section from YouTube${partLabel}`);
      parts = [];
      for (const [i, seg] of segments.entries()) {
        const partPath = work.file(`section-${i}.mp4`);
        await downloadYouTubeSection(youtubeId, seg.sourceStart, seg.sourceEnd, partPath);
        // The download already starts at the part, so read it from 0
        parts.push({
          inputPath: partPath,
          start: 0,
          duration: seg.sourceEnd - seg.sourceStart,
        });
      }
    } else {
      const sourcePath = await fetchToWorkDir(work, source.storageKey!, "source");
      parts = segments.map((seg) => ({
        inputPath: sourcePath,
        start: seg.sourceStart,
        duration: seg.sourceEnd - seg.sourceStart,
      }));
    }

    // Stitch first, then render normally: every step downstream works on
    // one continuous clip and needs no notion of parts.
    let inputPath = parts[0]!.inputPath;
    // Where the clip sits inside `inputPath`. A joined file, or a
    // per-window YouTube download, already *is* the clip and starts at 0;
    // a whole uploaded source must be seeked into.
    let renderStart = parts[0]!.start;
    if (parts.length > 1) {
      await emit(6, `Joining ${parts.length} parts`);
      const joinedPath = work.file("joined.mp4");
      const firstProbe = await probeVideo(parts[0]!.inputPath);
      await concatParts(parts, joinedPath, {
        hasAudio: firstProbe.hasAudio,
        fps: firstProbe.fps && firstProbe.fps > 0 ? Math.round(firstProbe.fps) : 30,
      });
      inputPath = joinedPath;
      renderStart = 0;
    }
    const renderEnd = renderStart + duration;

    // Captions → ASS file
    let assPath: string | undefined;
    if (plan.captions.enabled && clip.captions.length > 0) {
      const lines: CaptionLine[] = clip.captions.map((c) => ({
        startTime: timeMap.toOutput(c.startTime),
        endTime: timeMap.toOutput(c.endTime),
        text: c.text,
      }));
      const [w, h] = plan.resolution.split("x").map(Number);
      assPath = work.file("captions.ass");
      await writeFile(
        assPath,
        buildAssDocument(lines, {
          style: plan.captions.style,
          position: plan.captions.position,
          width: w || 1080,
          height: h || 1920,
        }),
        "utf8",
      );
    }

    const [width, height] = plan.resolution.split("x").map(Number);

    // Like/Follow call-to-action banner (its own burned ASS track)
    let ctaAssPath: string | undefined;
    if (plan.cta?.enabled) {
      ctaAssPath = work.file("cta.ass");
      await writeFile(
        ctaAssPath,
        buildCtaAss(plan.cta, {
          width: width || 1080,
          height: height || 1920,
          outputDuration,
        }),
        "utf8",
      );
    }

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { plan: true },
    });

    // Glow trail needs its sprite rendered up front
    let glowSpritePath: string | undefined;
    const trailEffect = (plan.rangeEffects ?? []).find(
      (e) => e.type === "glow_trail",
    );
    if (trailEffect && trailEffect.type === "glow_trail") {
      glowSpritePath = work.file("glow.png");
      await createGlowSprite(glowSpritePath, trailEffect.color ?? "ffd25a");
    }

    const spec: RenderSpec = {
      inputPath,
      outputPath: work.file("output.mp4"),
      sourceStart: renderStart,
      sourceEnd: renderEnd,
      width: width || 1080,
      height: height || 1920,
      blurBackground: plan.background?.type === "blurred_original",
      fillFrame: plan.background?.type === "crop_fill",
      zoom: segment.effects.some((e) => e.type === "zoom_in"),
      assPath,
      ctaAssPath,
      hasAudio: Boolean(source.audioKey) || true, // probe decides below
      watermarkText: user.plan === "FREE" ? WATERMARK_TEXT : undefined,
      rangeEffects: effectiveEffects,
      glowSpritePath,
      audio: plan.audio,
    };

    // AI subject cut-out: generate the per-frame mask before rendering
    if (bgRemoval) {
      await updateRenderJob({ progress: 8, step: "Removing background (AI)" });
      await emit(8, "Removing background (AI)");
      const maskPath = work.file("mask.gray");
      await generateMaskVideo({
        inputPath,
        start: renderStart,
        duration,
        outPath: maskPath,
        onProgress: (f) => {
          const pct = 8 + Math.round(f * 30);
          void updateRenderJob({ progress: pct, step: "Removing background (AI)" }).catch(() => undefined);
          void emit(pct, "Removing background (AI)");
        },
      });
      spec.backgroundRemoval = {
        maskPath,
        replace: bgRemoval.replace,
        color: bgRemoval.color,
      };
    }

    // Respect the actual stream layout
    const probe = await probeVideo(inputPath);
    spec.hasAudio = probe.hasAudio;

    await emit(8, "Rendering video");
    let lastPersist = 0;
    const progressBase = bgRemoval ? 38 : 8;
    const onProgress = (fraction: number) => {
      const pct = Math.min(95, progressBase + Math.round(fraction * (95 - progressBase)));
      const now = Date.now();
      if (now - lastPersist > 1500) {
        lastPersist = now;
        void updateRenderJob({ progress: pct, step: "Rendering video" }).catch(
          () => undefined,
        );
        void emit(pct, "Rendering video");
      }
    };

    const isOutOfMemory = (err: unknown) =>
      /Cannot allocate memory|Out of memory|malloc .*failed|bad allocation/i.test(
        String(err),
      );

    try {
      await runRender(spec, onProgress);
    } catch (err) {
      const missingFilter = String(err).match(/No such filter: '(\w+)'/)?.[1];
      if (missingFilter && missingFilter !== "drawtext") {
        throw new Error(
          `This ffmpeg build lacks the '${missingFilter}' filter needed for captions. ` +
            `Install a full build (brew install ffmpeg-full) or set FFMPEG_PATH.`,
        );
      }

      // Memory pressure: retry once fully single-threaded, which roughly
      // halves ffmpeg's peak footprint at the cost of render speed.
      if (isOutOfMemory(err)) {
        console.warn(
          `Render ran out of memory, retrying single-threaded: ${String(err).slice(0, 200)}`,
        );
        await updateRenderJob({ step: "Retrying in low-memory mode" });
        await emit(progressBase, "Retrying in low-memory mode");
        spec.threads = 1;
        try {
          await runRender(spec, onProgress);
        } catch (retryErr) {
          if (isOutOfMemory(retryErr)) {
            throw new Error(
              "Not enough free memory to render this clip. Close other applications " +
                "(browser tabs, editors) and try again, or render a shorter clip.",
            );
          }
          throw retryErr;
        }
      } else if (spec.watermarkText) {
        // Some FFmpeg builds lack fontconfig for drawtext — retry unwatermarked
        console.warn(
          `Render failed with watermark, retrying without: ${String(err).slice(0, 200)}`,
        );
        spec.watermarkText = undefined;
        await runRender(spec, onProgress);
      } else {
        throw err;
      }
    }

    // ── Quality control ──────────────────────────────────
    await updateRenderJob({ progress: 96, step: "Quality check" });
    await emit(96, "Quality check");
    const output = await probeVideo(spec.outputPath);
    if (Math.abs(output.durationSeconds - outputDuration) > 2) {
      throw new Error(
        `Quality check failed: output duration ${output.durationSeconds.toFixed(1)}s differs from expected ${outputDuration.toFixed(1)}s`,
      );
    }
    if (spec.hasAudio && !output.hasAudio) {
      throw new Error("Quality check failed: output lost its audio track");
    }

    // ── Upload + record export ───────────────────────────
    await updateRenderJob({ progress: 97, step: "Uploading" });
    await emit(97, "Uploading final video");
    const fileName = `${(clip.name ?? "clip").replace(/[^a-zA-Z0-9-_]+/g, "-").slice(0, 60) || "clip"}-${Math.round(duration)}s.mp4`;
    const storageKey = `users/${userId}/projects/${projectId}/exports/${clipId}-${Date.now()}.mp4`;
    await uploadFile(spec.outputPath, storageKey, "video/mp4");
    const { size } = await stat(spec.outputPath);

    await prisma.$transaction([
      prisma.export.create({
        data: {
          clipId,
          fileName,
          storageKey,
          format: "mp4",
          resolution: plan.resolution,
          sizeBytes: BigInt(size),
        },
      }),
      prisma.clip.update({
        where: { id: clipId },
        data: { status: "RENDERED", renderedKey: storageKey, duration: outputDuration },
      }),
      prisma.renderJob.update({
        where: { id: renderJobId },
        data: {
          status: "COMPLETED",
          progress: 100,
          step: "Completed",
          outputKey: storageKey,
          completedAt: new Date(),
        },
      }),
    ]);
    await publishProgress({
      projectId,
      clipId,
      status: "RENDERED",
      progress: 100,
      step: "Your video is ready",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    if (isFinalAttempt) {
      await prisma.$transaction([
        prisma.clip.update({
          where: { id: clipId },
          data: { status: "FAILED" },
        }),
        prisma.renderJob.update({
          where: { id: renderJobId },
          data: {
            status: "FAILED",
            error: message.slice(0, 1000),
            completedAt: new Date(),
          },
        }),
      ]);
      await refundCredits(userId, chargedCredits ?? renderCost(duration), {
        projectId,
        clipId,
      });
      await publishProgress({
        projectId,
        clipId,
        status: "FAILED",
        progress: 0,
        step: "Render failed",
        error: message,
      });
    }
    throw err;
  } finally {
    await work.cleanup();
  }
}
