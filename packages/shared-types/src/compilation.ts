/**
 * Compilations: a "best of" video built from moments found across
 * several YouTube videos for one prompt.
 *
 * Every moment keeps the video it came from and its timestamp there, so
 * a finished compilation can always be traced back to its sources —
 * which matters both for crediting them and for answering a claim.
 */

export interface CompilationMoment {
  videoId: string;
  videoTitle: string;
  channel: string;
  /** Where the moment sits in the source video, in seconds */
  start: number;
  end: number;
  /** Why it was picked, from the same scorer the highlight step uses */
  score: number;
  watchUrl: string;
}

export interface CompilationSummary {
  id: string;
  prompt: string;
  title: string | null;
  description: string | null;
  status: "PENDING" | "RESEARCHING" | "BUILDING" | "RENDERING" | "READY" | "FAILED";
  error: string | null;
  format: string;
  targetSeconds: number | null;
  progress: number;
  step: string | null;
  duration: number | null;
  createdAt: string;
  videoUrl?: string | null;
  moments?: CompilationMoment[] | null;
}

export const COMPILATION_CREDITS = 6;

/** Finished length the user can ask for. */
export const COMPILATION_LENGTHS = [60, 90, 120] as const;
export const MIN_COMPILATION_SECONDS = 30;
export const MAX_COMPILATION_SECONDS = 120;

/** How many search results are worth analysing for one compilation. */
export const MAX_CANDIDATE_VIDEOS = 6;
/** Each moment is long enough to register, short enough to keep moving. */
export const MOMENT_SECONDS = 12;

/**
 * Picks moments highest-score-first until the target length is reached,
 * taking at most one per source video on each pass so a single video
 * cannot fill the whole compilation.
 */
export function chooseMoments(
  candidates: CompilationMoment[],
  targetSeconds: number,
): CompilationMoment[] {
  const byScore = [...candidates].sort((a, b) => b.score - a.score);
  const chosen: CompilationMoment[] = [];
  const usedPerVideo = new Map<string, number>();
  let total = 0;

  // Round-robin by video: pass 1 takes each video's best moment, pass 2
  // its second best, and so on — a varied compilation, not one clip
  for (let round = 0; round < 4 && total < targetSeconds; round++) {
    for (const moment of byScore) {
      if (total >= targetSeconds) break;
      if ((usedPerVideo.get(moment.videoId) ?? 0) !== round) continue;
      if (chosen.some((c) => c.videoId === moment.videoId && c.start === moment.start)) {
        continue;
      }
      chosen.push(moment);
      usedPerVideo.set(moment.videoId, round + 1);
      total += moment.end - moment.start;
    }
  }
  return chosen;
}

/** Credits list naming every video a compilation drew from. */
export function buildCompilationCredits(moments: CompilationMoment[]): string {
  const seen = new Map<string, CompilationMoment>();
  for (const moment of moments) {
    if (!seen.has(moment.videoId)) seen.set(moment.videoId, moment);
  }
  return [...seen.values()]
    .map((m) => `${m.videoTitle} — ${m.channel} (${m.watchUrl})`)
    .join("\n");
}
