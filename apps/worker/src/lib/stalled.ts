import type { Job } from "bullmq";
import { getPrismaClient } from "@clipforge/database";
import {
  CREDIT_COSTS,
  QUEUES,
  renderCost,
  type HighlightGenerationJob,
  type RenderVideoJob,
  type VideoImportJob,
} from "@clipforge/shared-types";
import { refundCredits } from "./credits";
import { publishProgress } from "./progress";

const INTERRUPTED =
  "Processing was interrupted (the worker stopped mid-job). Please try again.";

/**
 * When a worker dies mid-job (crash, OOM, dev hot-reload) the processor's
 * own catch block never runs, so BullMQ eventually fails the job as
 * "stalled". Without this, the project/clip stays in a busy status the
 * UI can't recover from and the user keeps paying for nothing.
 *
 * Every update is conditional on the row still being busy, so a job the
 * processor already finalised is left alone and never refunded twice.
 */
export function isStalledFailure(err: Error): boolean {
  return /stalled/i.test(err.message);
}

export async function finalizeStalledJob(queue: string, job: Job): Promise<void> {
  const prisma = getPrismaClient();

  if (queue === QUEUES.VIDEO_IMPORT) {
    const { projectId, userId } = job.data as VideoImportJob;
    const { count } = await prisma.project.updateMany({
      where: { id: projectId, status: "IMPORTING" },
      data: { status: "FAILED", error: INTERRUPTED },
    });
    if (count === 0) return;
    await refundCredits(userId, CREDIT_COSTS.importVideo, { projectId });
    await publishProgress({ projectId, status: "FAILED", progress: 0, step: "Import failed", error: INTERRUPTED });
    return;
  }

  if (queue === QUEUES.HIGHLIGHT_GENERATION) {
    const { projectId, userId } = job.data as HighlightGenerationJob;
    const { count } = await prisma.project.updateMany({
      where: { id: projectId, status: { in: ["ANALYZING", "GENERATING_HIGHLIGHTS"] } },
      data: { status: "FAILED", error: INTERRUPTED },
    });
    if (count === 0) return;
    await refundCredits(userId, CREDIT_COSTS.generateHighlights, { projectId });
    await publishProgress({ projectId, status: "FAILED", progress: 0, step: "Highlight generation failed", error: INTERRUPTED });
    return;
  }

  if (queue === QUEUES.RENDER_VIDEO) {
    const { clipId, renderJobId, userId, chargedCredits } = job.data as RenderVideoJob;
    const clip = await prisma.clip.findUnique({
      where: { id: clipId },
      select: { projectId: true, duration: true },
    });
    const { count } = await prisma.clip.updateMany({
      where: { id: clipId, status: { in: ["RENDER_QUEUED", "RENDERING"] } },
      data: { status: "FAILED" },
    });
    if (count === 0) return;
    await prisma.renderJob.updateMany({
      where: { id: renderJobId, status: { in: ["PENDING", "RUNNING"] } },
      data: { status: "FAILED", error: INTERRUPTED, completedAt: new Date() },
    });
    await refundCredits(userId, chargedCredits ?? renderCost(clip?.duration ?? 0), { clipId });
    if (clip) {
      await publishProgress({ projectId: clip.projectId, clipId, status: "FAILED", progress: 0, step: "Render failed", error: INTERRUPTED });
    }
  }
}
