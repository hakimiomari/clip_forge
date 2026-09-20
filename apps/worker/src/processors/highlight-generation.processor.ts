import type { Job } from "bullmq";
import { getPrismaClient } from "@clipforge/database";
import type { HighlightGenerationJob } from "@clipforge/shared-types";
import { CREDIT_COSTS } from "@clipforge/shared-types";
import { analyzeMedia } from "../lib/analysis";
import { extractAudio } from "../lib/ffmpeg";
import { createWorkDir, fetchToWorkDir } from "../lib/media";
import {
  fetchYouTubeInfo,
  fetchYouTubeTranscript,
  resolveYouTubeStreams,
} from "../lib/youtube";

/** Replaces the project's transcript and its segments in one transaction. */
async function saveTranscript(
  projectId: string,
  result: {
    language: string | null;
    provider: string;
    segments: TranscriptSegmentLite[];
  },
): Promise<void> {
  const prisma = getPrismaClient();
  const fullText = result.segments.map((s) => s.text).join(" ");
  await prisma.$transaction(async (tx) => {
    const transcript = await tx.transcript.upsert({
      where: { projectId },
      create: {
        projectId,
        status: "COMPLETED",
        language: result.language,
        provider: result.provider,
        fullText,
      },
      update: {
        status: "COMPLETED",
        language: result.language,
        provider: result.provider,
        fullText,
        error: null,
      },
    });
    await tx.transcriptSegment.deleteMany({ where: { transcriptId: transcript.id } });
    if (result.segments.length > 0) {
      await tx.transcriptSegment.createMany({
        data: result.segments.map((s, index) => ({
          transcriptId: transcript.id,
          index,
          startTime: s.startTime,
          endTime: s.endTime,
          text: s.text,
        })),
      });
    }
  });
}
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
  const isYouTube = source?.sourceType === "YOUTUBE" && Boolean(source.externalId);
  if (!source?.duration || (!source.storageKey && !isYouTube)) {
    throw new Error(
      "This project has no processable media. Import a video to generate highlights.",
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

    // Where analysis reads audio/video from: a local copy for uploads,
    // or YouTube CDN streams read directly by ffmpeg (nothing stored).
    let audioInput: string | null = null;
    let videoInput: string | null = null;
    if (isYouTube) {
      await emit("ANALYZING", 8, "Connecting to YouTube");
      const streams = await resolveYouTubeStreams(source.externalId!);
      audioInput = streams.audioUrl;
      videoInput = streams.videoUrl;
    }

    // The user can opt out of transcript-guided selection entirely
    const useTranscript = options.useTranscript !== false;

    let segments: TranscriptSegmentLite[] =
      useTranscript && project.transcript?.status === "COMPLETED"
        ? project.transcript.segments
            .sort((a, b) => a.index - b.index)
            .map((s) => ({ startTime: s.startTime, endTime: s.endTime, text: s.text }))
        : [];

    // YouTube's own captions are free and usually good — try them first
    if (useTranscript && segments.length === 0 && isYouTube) {
      await emit("ANALYZING", 12, "Fetching YouTube transcript");
      try {
        const info = await fetchYouTubeInfo(source.externalId!);
        if (info.captions) {
          const result = await fetchYouTubeTranscript(source.externalId!, info.captions, work.dir);
          if (result.segments.length > 0) {
            segments = result.segments;
            await saveTranscript(projectId, result);
          }
        }
      } catch (err) {
        console.warn(`YouTube captions unavailable, continuing: ${String(err).slice(0, 200)}`);
      }
    }

    // Otherwise transcribe the audio when a provider is configured
    if (useTranscript && segments.length === 0 && transcriptionConfigured() && (source.audioKey || audioInput)) {
      await emit("ANALYZING", 15, "Transcribing audio");
      try {
        let audioPath: string;
        if (source.audioKey) {
          audioPath = await fetchToWorkDir(work, source.audioKey, "audio");
        } else {
          // Transcription APIs need a file; pull a compact mono track from the stream
          audioPath = work.file("audio.m4a");
          await extractAudio(audioInput!, audioPath);
        }
        const result = await transcribeAudio(audioPath, work.file);
        segments = result.segments;
        await saveTranscript(projectId, result);
      } catch (err) {
        // Transcription failing shouldn't kill highlight generation
        const message = err instanceof Error ? err.message : String(err);
        await prisma.transcript.upsert({
          where: { projectId },
          create: { projectId, status: "FAILED", error: message.slice(0, 500) },
          update: { status: "FAILED", error: message.slice(0, 500) },
        });
      }
    } else if (useTranscript && segments.length === 0) {
      await prisma.transcript.upsert({
        where: { projectId },
        create: { projectId, status: "UNAVAILABLE" },
        update: {},
      });
    }

    // ── 2. Signal analysis ───────────────────────────────
    await emit("ANALYZING", 35, "Analyzing scenes and audio");
    if (!audioInput) {
      // Audio passes read the compact extracted track when available —
      // decoding it is much cheaper than demuxing the full video twice
      if (source.audioKey) {
        audioInput = await fetchToWorkDir(work, source.audioKey, "audio-small");
      }
      const mediaPath = await fetchToWorkDir(work, source.storageKey!, "source");
      audioInput ??= mediaPath;
      videoInput = mediaPath;
    }
    const analysis = await analyzeMedia({
      audio: audioInput,
      video: videoInput,
      durationSeconds: source.duration,
    });

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
