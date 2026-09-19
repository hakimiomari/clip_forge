import type { Job } from "bullmq";
import { writeFile, stat } from "fs/promises";
import { getPrismaClient } from "@clipforge/database";
import type { EditingPlan, RenderVideoJob } from "@clipforge/shared-types";
import { renderCost } from "@clipforge/shared-types";
import { buildAssDocument, type CaptionLine } from "../lib/captions";
import { createWorkDir, fetchToWorkDir } from "../lib/media";
import { runRender, type RenderSpec } from "../lib/render";
import { probeVideo } from "../lib/ffmpeg";
import { uploadFile } from "../lib/storage";
import { publishProgress } from "../lib/progress";
import { refundCredits } from "../lib/credits";

/**
 * render-video: Rendering Agent + Quality Control Agent.
 * Consumes the clip's editing plan, renders the MP4 with FFmpeg,
 * verifies the output, uploads it and records an Export.
 */
export async function processRenderVideo(job: Job<RenderVideoJob>): Promise<void> {
  const { clipId, renderJobId, userId } = job.data;
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
  if (!source?.storageKey) {
    throw new Error("Source media is missing — cannot render this clip");
  }
  const plan = clip.editingPlan as unknown as EditingPlan | null;
  const segment = plan?.segments?.[0];
  if (!plan || !segment) {
    throw new Error("Clip has no editing plan");
  }

  const projectId = clip.projectId;
  const duration = segment.sourceEnd - segment.sourceStart;

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

    const inputPath = await fetchToWorkDir(work, source.storageKey, "source");

    // Captions → ASS file
    let assPath: string | undefined;
    if (plan.captions.enabled && clip.captions.length > 0) {
      const lines: CaptionLine[] = clip.captions.map((c) => ({
        startTime: c.startTime,
        endTime: c.endTime,
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
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { plan: true },
    });

    const spec: RenderSpec = {
      inputPath,
      outputPath: work.file("output.mp4"),
      sourceStart: segment.sourceStart,
      sourceEnd: segment.sourceEnd,
      width: width || 1080,
      height: height || 1920,
      blurBackground: plan.background?.type === "blurred_original",
      zoom: segment.effects.some((e) => e.type === "zoom_in"),
      assPath,
      hasAudio: Boolean(source.audioKey) || true, // probe decides below
      watermarkText: user.plan === "FREE" ? "Made with ClipForge" : undefined,
    };

    // Respect the actual stream layout
    const probe = await probeVideo(inputPath);
    spec.hasAudio = probe.hasAudio;

    await emit(8, "Rendering video");
    let lastPersist = 0;
    const onProgress = (fraction: number) => {
      const pct = Math.min(95, 8 + Math.round(fraction * 82));
      const now = Date.now();
      if (now - lastPersist > 1500) {
        lastPersist = now;
        void updateRenderJob({ progress: pct, step: "Rendering video" }).catch(
          () => undefined,
        );
        void emit(pct, "Rendering video");
      }
    };

    try {
      await runRender(spec, onProgress);
    } catch (err) {
      // Some FFmpeg builds lack fontconfig for drawtext — retry unwatermarked
      if (spec.watermarkText) {
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
    if (Math.abs(output.durationSeconds - duration) > 2) {
      throw new Error(
        `Quality check failed: output duration ${output.durationSeconds.toFixed(1)}s differs from expected ${duration.toFixed(1)}s`,
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
        data: { status: "RENDERED", renderedKey: storageKey, duration },
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
      await refundCredits(userId, renderCost(duration), { projectId, clipId });
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
