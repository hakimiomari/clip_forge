import { mkdir } from "fs/promises";
import path from "path";
import {
  MOMENT_SECONDS,
  type CompilationMoment,
} from "@clipforge/shared-types";
import { analyzeMedia } from "../analysis";
import {
  downloadAnalysisMedia,
  downloadAudioSection,
  fetchVideoSignals,
  type HeatmapPoint,
} from "../youtube";
import { selectHighlights } from "../heuristics";
import type { Candidate } from "./search";

/**
 * Locates the strongest moments inside one candidate video, as cheaply
 * as the video allows:
 *
 * 1. Replay heatmap (when YouTube has one) — viewers' own rewinds point
 *    at the best stretches, for the cost of one metadata request. The
 *    exact moment inside each peak is then found from just that
 *    stretch's audio, so even a 6-hour match costs a few seconds.
 * 2. Otherwise, low-bitrate audio for the whole video, scored for crowd
 *    noise and commentary spikes — the same scorer the highlight step
 *    uses, at a fraction of the download.
 */

/** Shorter than this, a heatmap bucket is precise enough to cut as-is. */
const PRECISE_BUCKET_SECONDS = 30;
/** Opening stretch never treated as a highlight — title cards, logos. */
const MIN_INTRO_SECONDS = 8;

/** Where a video's intro is taken to end: 8s, or 3% of a long video. */
export function introEndSeconds(durationSeconds: number): number {
  return Math.max(MIN_INTRO_SECONDS, durationSeconds * 0.03);
}

/**
 * Highest-replayed stretches, skipping neighbours of ones already taken
 * (one great play spans adjacent buckets) and the opening bucket, whose
 * replay count is inflated by viewers skimming the intro.
 */
export function pickHeatmapPeaks(
  heatmap: HeatmapPoint[],
  count: number,
  durationSeconds: number,
): HeatmapPoint[] {
  // At least 8s: a compilation's title card or logo usually runs 5–15s,
  // and a bare 3% of a two-minute video would let the intro through
  const introEnd = Math.max(introEndSeconds(durationSeconds), heatmap[0]?.end ?? 0);
  const ranked = heatmap
    .filter((p) => p.start >= introEnd - 0.01 && p.end > p.start)
    .sort((a, b) => b.value - a.value);

  const picked: HeatmapPoint[] = [];
  for (const point of ranked) {
    if (picked.length >= count) break;
    const width = point.end - point.start;
    const touches = picked.some(
      (p) => Math.abs(p.start - point.start) <= width * 1.01,
    );
    if (!touches) picked.push(point);
  }
  return picked;
}

/**
 * Replay data is a stronger signal than loudness, so heatmap moments
 * rank above audio ones on the same 0–100 scale.
 */
export function heatmapScore(value: number): number {
  return Math.round(50 + Math.max(0, Math.min(1, value)) * 50);
}

function toMoment(
  candidate: Candidate,
  start: number,
  end: number,
  score: number,
  method: "heatmap" | "audio",
): CompilationMoment {
  return {
    videoId: candidate.videoId,
    videoTitle: candidate.title,
    channel: candidate.channel,
    start: Math.max(0, Math.round(start * 10) / 10),
    end: Math.min(candidate.durationSeconds, Math.round(end * 10) / 10),
    score,
    watchUrl: candidate.watchUrl,
    method,
    recent: candidate.recent,
  };
}

/** The loudest short window inside an audio file, as a start offset. */
async function loudestWindow(
  audioPath: string,
  durationSeconds: number,
): Promise<{ start: number; end: number; score: number } | null> {
  const analysis = await analyzeMedia({ audio: audioPath, video: null, durationSeconds });
  const [best] = selectHighlights({
    duration: durationSeconds,
    targetLength: MOMENT_SECONDS,
    count: 1,
    analysis,
    minWindowSeconds: MOMENT_SECONDS - 2,
  });
  return best ? { start: best.startTime, end: best.endTime, score: best.score } : null;
}

async function momentsFromHeatmap(
  candidate: Candidate,
  heatmap: HeatmapPoint[],
  dir: string,
  perVideo: number,
): Promise<CompilationMoment[]> {
  const peaks = pickHeatmapPeaks(heatmap, perVideo, candidate.durationSeconds);
  const moments: CompilationMoment[] = [];

  for (const [i, peak] of peaks.entries()) {
    const width = peak.end - peak.start;
    const score = heatmapScore(peak.value);

    if (width <= PRECISE_BUCKET_SECONDS) {
      // Narrow enough already: centre the moment on the bucket, but never
      // let centring pull the window back into the intro
      const middle = Math.max(
        (peak.start + peak.end) / 2,
        MIN_INTRO_SECONDS + MOMENT_SECONDS / 2,
      );
      moments.push(
        toMoment(
          candidate,
          middle - MOMENT_SECONDS / 2,
          middle + MOMENT_SECONDS / 2,
          score,
          "heatmap",
        ),
      );
      continue;
    }

    // A long video's bucket spans minutes — find the play inside it from
    // that stretch's audio alone
    try {
      const sectionPath = path.join(dir, `peak-${i}.m4a`);
      await downloadAudioSection(candidate.videoId, peak.start, peak.end, sectionPath);
      const inside = await loudestWindow(sectionPath, width);
      if (inside) {
        moments.push(
          toMoment(
            candidate,
            peak.start + inside.start,
            peak.start + inside.end,
            score,
            "heatmap",
          ),
        );
        continue;
      }
    } catch (err) {
      console.warn(`Peak ${i + 1} of ${candidate.videoId} unrefined: ${String(err).slice(0, 120)}`);
    }
    // Couldn't refine — the peak's start is still a far better guess
    // than nothing
    moments.push(
      toMoment(candidate, peak.start, peak.start + MOMENT_SECONDS, score, "heatmap"),
    );
  }
  return moments;
}

async function momentsFromAudio(
  candidate: Candidate,
  dir: string,
  perVideo: number,
  downloadTimeoutMs: number | undefined,
): Promise<CompilationMoment[]> {
  const media = await downloadAnalysisMedia(candidate.videoId, dir, {
    includeVideo: false,
    audioQuality: "lean",
    timeoutMs: downloadTimeoutMs,
  });
  const analysis = await analyzeMedia({
    audio: media.audioPath,
    video: null,
    durationSeconds: candidate.durationSeconds,
  });
  const picks = selectHighlights({
    duration: candidate.durationSeconds,
    targetLength: MOMENT_SECONDS,
    // A couple spare, since picks inside the intro are dropped below
    count: perVideo + 2,
    analysis,
    // A moment only has to be long enough for the play itself; the
    // default 15s floor is for standalone clips and would reject every
    // 12s window here
    minWindowSeconds: MOMENT_SECONDS - 2,
  });
  // Intros are loud — music stings, crowd shots — and score well on
  // audio alone, but they are never the moment anyone is looking for
  const introEnd = introEndSeconds(candidate.durationSeconds);
  const kept = picks.filter((p) => p.startTime >= introEnd).slice(0, perVideo);
  if (kept.length === 0) {
    console.warn(`No moments scored in ${candidate.videoId} (${candidate.durationSeconds}s)`);
  }
  return kept.map((p) => toMoment(candidate, p.startTime, p.endTime, p.score, "audio"));
}

export async function findMoments(options: {
  candidate: Candidate;
  workDir: string;
  perVideo: number;
  /** Kill the whole-video audio download past this. */
  downloadTimeoutMs?: number;
}): Promise<CompilationMoment[]> {
  const { candidate, workDir, perVideo, downloadTimeoutMs } = options;

  // Each candidate needs its own folder. The analysis download always
  // writes the same filename, and yt-dlp skips a file that already
  // exists — so in a shared folder every video after the first was
  // silently scored using the first video's audio.
  const dir = path.join(workDir, `candidate-${candidate.videoId}`);
  await mkdir(dir, { recursive: true });

  let heatmap: HeatmapPoint[] = [];
  try {
    heatmap = (await fetchVideoSignals(candidate.videoId)).heatmap;
  } catch (err) {
    console.warn(`No signals for ${candidate.videoId}: ${String(err).slice(0, 120)}`);
  }

  return heatmap.length > 0
    ? momentsFromHeatmap(candidate, heatmap, dir, perVideo)
    : momentsFromAudio(candidate, dir, perVideo, downloadTimeoutMs);
}
