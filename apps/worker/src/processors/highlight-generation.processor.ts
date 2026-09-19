import type { Job } from "bullmq";
import { getPrismaClient } from "@clipforge/database";
import type { HighlightGenerationJob } from "@clipforge/shared-types";
import { CREDIT_COSTS } from "@clipforge/shared-types";
import { analyzeMedia } from "../lib/analysis";
import { createWorkDir, fetchToWorkDir } from "../lib/media";
import {
  selectHighlights,
  type HighlightCandidate,
  type TranscriptSegmentLite,
} from "../lib/heuristics";
import { selectHighlightsWithLlm } from "../lib/highlight-ai";
import { llmConfigured } from "../lib/llm";
import { transcribeAudio, transcriptionConfigured } from "../lib/transcribe";
import { publishProgress } from "../lib/progress";
import { refundCredits } from "../lib/credits";

/**
 * highlight-generation: Transcript Agent → Scene/Audio Analysis Agent →
 * Highlight Selection Agent (LLM when configured, signal heuristics
 * otherwise). Produces scored Highlight rows for the project.
 */
export async function processHighlightGeneration(
  job: Job<HighlightGenerationJob>,
): Promise<void> {
  const { projectId, userId, options } = job.data;
  const prisma = getPrismaClient();

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { source: true, transcript: { include: { segments: true } } },
  });
  if (!project || project.userId !== userId) {
    throw new Error(`Project ${projectId} not found for user`);
  }
  const source = project.source;
  if (!source?.storageKey || !source.duration) {
    throw new Error(
      "This project has no processable media. Upload a video file to generate highlights.",
    );
  }

  const emit = (status: string, progress: number, step: string) =>
    publishProgress({ projectId, status, progress, step });

  const work = await createWorkDir(`hl-${projectId}`);
  try {
    // ── 1. Transcript ────────────────────────────────────
    await prisma.project.update({
      where: { id: projectId },
      data: { status: "ANALYZING", error: null },
    });
    await emit("ANALYZING", 5, "Preparing analysis");

    let segments: TranscriptSegmentLite[] =
      project.transcript?.status === "COMPLETED"
        ? project.transcript.segments
            .sort((a, b) => a.index - b.index)
            .map((s) => ({ startTime: s.startTime, endTime: s.endTime, text: s.text }))
        : [];

    if (segments.length === 0 && transcriptionConfigured() && source.audioKey) {
      await emit("ANALYZING", 12, "Transcribing audio");
      try {
        const audioPath = await fetchToWorkDir(work, source.audioKey, "audio");
        const result = await transcribeAudio(audioPath, work.file);
        segments = result.segments;
        await prisma.$transaction(async (tx) => {
          const transcript = await tx.transcript.upsert({
            where: { projectId },
            create: {
              projectId,
              status: "COMPLETED",
              language: result.language,
              provider: result.provider,
              fullText: segments.map((s) => s.text).join(" "),
            },
            update: {
              status: "COMPLETED",
              language: result.language,
              provider: result.provider,
              fullText: segments.map((s) => s.text).join(" "),
              error: null,
            },
          });
          await tx.transcriptSegment.deleteMany({
            where: { transcriptId: transcript.id },
          });
          if (segments.length > 0) {
            await tx.transcriptSegment.createMany({
              data: segments.map((s, index) => ({
                transcriptId: transcript.id,
                index,
                startTime: s.startTime,
                endTime: s.endTime,
                text: s.text,
              })),
            });
          }
        });
      } catch (err) {
        // Transcription failing shouldn't kill highlight generation
        const message = err instanceof Error ? err.message : String(err);
        await prisma.transcript.upsert({
          where: { projectId },
          create: { projectId, status: "FAILED", error: message.slice(0, 500) },
          update: { status: "FAILED", error: message.slice(0, 500) },
        });
      }
    } else if (segments.length === 0 && !transcriptionConfigured()) {
      await prisma.transcript.upsert({
        where: { projectId },
        create: { projectId, status: "UNAVAILABLE" },
        update: {},
      });
    }

    // ── 2. Signal analysis ───────────────────────────────
    await emit("ANALYZING", 35, "Analyzing scenes and audio");
    const mediaPath = await fetchToWorkDir(work, source.storageKey, "source");
    const analysis = await analyzeMedia(mediaPath, { hasVideo: true });

    // ── 3. Highlight selection ───────────────────────────
    await prisma.project.update({
      where: { id: projectId },
      data: { status: "GENERATING_HIGHLIGHTS" },
    });
    await emit("GENERATING_HIGHLIGHTS", 65, "Selecting the best moments");

    let candidates: HighlightCandidate[] | null = null;
    if (llmConfigured() && segments.length > 0) {
      try {
        candidates = await selectHighlightsWithLlm({
          transcript: segments,
          duration: source.duration,
          targetLength: options.clipDuration,
          count: options.clipCount,
        });
      } catch (err) {
        console.warn(
          `LLM highlight selection failed, falling back to heuristics: ${String(err)}`,
        );
      }
    }
    candidates ??= selectHighlights({
      duration: source.duration,
      targetLength: options.clipDuration,
      count: options.clipCount,
      analysis,
      transcript: segments.length > 0 ? segments : undefined,
    });

    if (candidates.length === 0) {
      throw new Error(
        "Could not find usable highlight moments in this video. Try a longer video or a shorter clip duration.",
      );
    }

    // ── 4. Persist ───────────────────────────────────────
    await emit("GENERATING_HIGHLIGHTS", 90, "Saving highlight suggestions");
    await prisma.$transaction(async (tx) => {
      await tx.highlight.deleteMany({ where: { projectId } });
      await tx.highlight.createMany({
        data: candidates.map((c) => ({
          projectId,
          startTime: c.startTime,
          endTime: c.endTime,
          duration: Math.round((c.endTime - c.startTime) * 10) / 10,
          score: c.score,
          title: c.title,
          hook: c.hook,
          reason: c.reason,
          category: c.category,
          confidence: c.confidence,
        })),
      });
      await tx.project.update({
        where: { id: projectId },
        data: { status: "READY" },
      });
    });
    await emit("READY", 100, `Found ${candidates.length} highlight${candidates.length === 1 ? "" : "s"}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    if (isFinalAttempt) {
      await prisma.project.update({
        where: { id: projectId },
        data: { status: "FAILED", error: message.slice(0, 1000) },
      });
      await refundCredits(userId, CREDIT_COSTS.generateHighlights, { projectId });
      await publishProgress({
        projectId,
        status: "FAILED",
        progress: 0,
        step: "Highlight generation failed",
        error: message,
      });
    }
    throw err;
  } finally {
    await work.cleanup();
  }
}
