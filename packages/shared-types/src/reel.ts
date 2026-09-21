import { MAX_CLIP_PARTS } from "./editing-plan.js";

/**
 * Best-moments video: the project's strongest moments, cut together in
 * the order they happen into one finished video. Built as an ordinary
 * multi-part clip, so it renders, re-renders and edits like any other.
 */

/** Finished lengths offered, in seconds. */
export const REEL_LENGTHS = [60, 90, 120, 180] as const;
export const MIN_REEL_SECONDS = 30;
export const MAX_REEL_SECONDS = 180;
/** Length of each moment the selector looks for. */
export const REEL_MOMENT_SECONDS = 15;
/**
 * Extra moments asked of the selector: it allows some overlap between
 * picks, and overlapping ones are dropped here.
 */
const SPARE_MOMENTS = 4;

/** How many moments to ask the highlight selector for. */
export function reelCandidateCount(targetSeconds: number): number {
  return Math.min(MAX_CLIP_PARTS, Math.ceil(targetSeconds / REEL_MOMENT_SECONDS)) + SPARE_MOMENTS;
}

export interface ReelMoment {
  start: number;
  end: number;
  score: number;
}

/**
 * Best-scoring moments that don't overlap, until the target length is
 * reached, then put back in story order — a match reads wrong if the
 * winning shot plays before the first wicket.
 */
export function buildReelParts<T extends ReelMoment>(
  moments: T[],
  targetSeconds: number,
): T[] {
  const byScore = [...moments]
    .filter((m) => m.end > m.start)
    .sort((a, b) => b.score - a.score);
  const picked: T[] = [];
  let total = 0;
  for (const moment of byScore) {
    if (total >= targetSeconds || picked.length >= MAX_CLIP_PARTS) break;
    const overlaps = picked.some((p) => moment.start < p.end && moment.end > p.start);
    if (overlaps) continue;
    // Never run past the target by more than a few seconds
    const length = moment.end - moment.start;
    if (total + length > targetSeconds + 5 && picked.length > 0) continue;
    picked.push(moment);
    total += length;
  }
  return picked.sort((a, b) => a.start - b.start);
}
