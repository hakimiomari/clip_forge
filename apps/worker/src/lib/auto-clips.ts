import { getPrismaClient } from "@clipforge/database";
import type { Prisma } from "@clipforge/database";
import {
  buildClipDescription,
  buildClipTitle,
  buildEditingPlan,
  EDITING_PLAN_VERSION,
  type AutoClipOptions,
  type CaptionStyleName,
  type VideoFormat,
} from "@clipforge/shared-types";
import { enqueueRender } from "./render-queue";
import type { TranscriptSegmentLite } from "./heuristics";

/**
 * Automatic mode: turn the chosen moments into rendered shorts without
 * the user clicking each one. Runs in the worker so the shorts still
 * appear if the page is closed straight after pressing the button.
 *
 * The renders were paid for up front (the API charges per requested
 * short), so each render job carries what it cost and refunds that on
 * failure — the same accounting a manually created clip uses.
 */

export interface AutoClipSource {
  highlightId: string;
  start: number;
  end: number;
  title: string | null;
}

export async function createAutoClips(args: {
  projectId: string;
  userId: string;
  highlights: AutoClipSource[];
  format: VideoFormat;
  captionStyle: CaptionStyleName | string;
  options: AutoClipOptions;
  creditsPerClip: number;
  transcript: TranscriptSegmentLite[];
  /** Source details for the ready-to-post caption */
  sourceTitle?: string | null;
  sourceUrl?: string | null;
}): Promise<number> {
  const prisma = getPrismaClient();
  let created = 0;

  for (const highlight of args.highlights) {
    const parts = [{ start: highlight.start, end: highlight.end }];
    const plan = buildEditingPlan({
      parts,
      format: args.format,
      captionsEnabled: args.options.captionsEnabled,
      captionStyle: args.captionStyle,
      zoomEnabled: args.options.zoomEnabled,
      backgroundMode: args.options.backgroundMode,
      ctaEnabled: args.options.ctaEnabled,
    });
    const duration = highlight.end - highlight.start;
    const metadata = {
      sourceTitle: args.sourceTitle,
      sourceUrl: args.sourceUrl,
      parts,
      spokenLines: args.transcript
        .filter((s) => s.startTime < highlight.end && s.endTime > highlight.start)
        .map((s) => s.text),
      highlightTitle: highlight.title,
    };

    // One transaction per short: a failure leaves the others intact
    const { clipId, renderJobId } = await prisma.$transaction(async (tx) => {
      const clip = await tx.clip.create({
        data: {
          projectId: args.projectId,
          highlightId: highlight.highlightId,
          name: buildClipTitle(metadata),
          description: buildClipDescription(metadata),
          status: "RENDER_QUEUED",
          format: args.format,
          resolution: plan.resolution,
          template: "auto_v1",
          duration,
          editingPlan: plan as unknown as Prisma.InputJsonValue,
          planVersion: EDITING_PLAN_VERSION,
        },
      });

      const captions = captionsForWindow(args.transcript, highlight.start, highlight.end);
      if (captions.length > 0) {
        await tx.caption.createMany({
          data: captions.map((c, index) => ({ clipId: clip.id, index, ...c })),
        });
      }

      const renderJob = await tx.renderJob.create({
        data: { clipId: clip.id, status: "PENDING", step: "Queued" },
      });
      return { clipId: clip.id, renderJobId: renderJob.id };
    });

    await enqueueRender({
      clipId,
      renderJobId,
      userId: args.userId,
      chargedCredits: args.creditsPerClip,
    });
    created++;
  }

  return created;
}

/**
 * Best-moments video: every moment cut together, in order, as one
 * multi-part clip. Returns the render's cost so the caller can refund
 * what was pre-paid beyond it.
 */
export async function createReelClip(args: {
  projectId: string;
  userId: string;
  parts: Array<{ start: number; end: number }>;
  format: VideoFormat;
  captionStyle: CaptionStyleName | string;
  options: AutoClipOptions;
  credits: number;
  transcript: TranscriptSegmentLite[];
  sourceTitle?: string | null;
  sourceUrl?: string | null;
}): Promise<string> {
  const prisma = getPrismaClient();
  const { parts } = args;
  const plan = buildEditingPlan({
    parts,
    format: args.format,
    captionsEnabled: args.options.captionsEnabled,
    captionStyle: args.captionStyle,
    zoomEnabled: args.options.zoomEnabled,
    backgroundMode: args.options.backgroundMode,
    ctaEnabled: args.options.ctaEnabled,
  });
  const duration = parts.reduce((sum, p) => sum + (p.end - p.start), 0);
  const source = args.sourceTitle?.trim();
  const metadata = {
    sourceTitle: args.sourceTitle,
    sourceUrl: args.sourceUrl,
    parts,
    spokenLines: args.transcript
      .filter((s) => parts.some((p) => s.startTime < p.end && s.endTime > p.start))
      .map((s) => s.text),
    clipName: source ? `Best moments — ${source}` : "Best moments",
  };

  const { clipId, renderJobId } = await prisma.$transaction(async (tx) => {
    const clip = await tx.clip.create({
      data: {
        projectId: args.projectId,
        name: buildClipTitle(metadata),
        description: buildClipDescription(metadata),
        status: "RENDER_QUEUED",
        format: args.format,
        resolution: plan.resolution,
        template: "auto_v1",
        duration,
        editingPlan: plan as unknown as Prisma.InputJsonValue,
        planVersion: EDITING_PLAN_VERSION,
      },
    });
    const captions = captionsForParts(args.transcript, parts);
    if (captions.length > 0) {
      await tx.caption.createMany({
        data: captions.map((c, index) => ({ clipId: clip.id, index, ...c })),
      });
    }
    const renderJob = await tx.renderJob.create({
      data: { clipId: clip.id, status: "PENDING", step: "Queued" },
    });
    return { clipId: clip.id, renderJobId: renderJob.id };
  });

  await enqueueRender({
    clipId,
    renderJobId,
    userId: args.userId,
    chargedCredits: args.credits,
  });
  return clipId;
}

/**
 * Transcript lines for a clip stitched from several windows, placed on
 * the stitched timeline: part 2's lines start where part 1 ends.
 */
export function captionsForParts(
  transcript: TranscriptSegmentLite[],
  parts: Array<{ start: number; end: number }>,
): Array<{ startTime: number; endTime: number; text: string }> {
  const out: Array<{ startTime: number; endTime: number; text: string }> = [];
  let offset = 0;
  for (const part of parts) {
    for (const c of captionsForWindow(transcript, part.start, part.end)) {
      out.push({ ...c, startTime: c.startTime + offset, endTime: c.endTime + offset });
    }
    offset += part.end - part.start;
  }
  return out;
}

/** Transcript lines inside the window, re-timed to start at the clip. */
export function captionsForWindow(
  transcript: TranscriptSegmentLite[],
  start: number,
  end: number,
): Array<{ startTime: number; endTime: number; text: string }> {
  const length = end - start;
  return transcript
    .filter((s) => s.startTime < end && s.endTime > start)
    .map((s) => ({
      startTime: Math.max(0, s.startTime - start),
      endTime: Math.min(length, s.endTime - start),
      text: s.text,
    }));
}
