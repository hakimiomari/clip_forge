import type { MediaAnalysis } from "./analysis";

/**
 * Offline highlight selection from measurable signal: audio energy,
 * speech density, silences and scene cuts, plus transcript cues when a
 * transcript exists. This is the fallback "Highlight Agent" used when no
 * LLM provider is configured — deterministic, explainable scoring.
 */

export interface TranscriptSegmentLite {
  startTime: number;
  endTime: number;
  text: string;
}

export interface HighlightCandidate {
  startTime: number;
  endTime: number;
  score: number; // 0–100
  title: string;
  hook: string | null;
  reason: string;
  category: string;
  confidence: number;
}

const CUE_WORDS = [
  "secret", "mistake", "important", "never", "always", "how to", "why",
  "the truth", "nobody", "everyone", "biggest", "best", "worst", "amazing",
  "crazy", "unbelievable", "here's the thing", "listen", "remember",
  "first thing", "problem", "solution", "money", "free", "warning", "stop",
  "?",
];

interface ScoredWindow extends HighlightCandidate {
  parts: {
    energy: number;
    dynamics: number;
    cleanStart: number;
    cleanEnd: number;
    speech: number;
    cue: number;
  };
}

export function selectHighlights(options: {
  duration: number;
  targetLength: number;
  count: number;
  analysis: MediaAnalysis;
  transcript?: TranscriptSegmentLite[];
  /**
   * Shortest window worth scoring. 15s suits a standalone clip; a
   * compilation strings together short moments and passes less.
   */
  minWindowSeconds?: number;
}): HighlightCandidate[] {
  const { duration, analysis } = options;
  const minWindow = options.minWindowSeconds ?? 15;
  const targetLength = Math.min(options.targetLength, Math.max(10, duration));
  const energy = analysis.energyPerSecond;
  if (duration <= 0) return [];

  const stats = energyStats(energy);
  const silenceEnds = analysis.silences.map((s) => s.end);
  const silenceStarts = analysis.silences.map((s) => s.start);
  const anchors = [...silenceEnds, ...analysis.sceneChanges].sort((a, b) => a - b);
  const speechFloor = stats.mean - 0.25 * stats.std;

  const step = Math.max(2, Math.min(5, Math.floor(targetLength / 6)));
  const windows: ScoredWindow[] = [];

  for (let start = 0; start <= Math.max(0, duration - targetLength * 0.6); start += step) {
    const end = Math.min(duration, start + targetLength);
    if (end - start < Math.min(minWindow, duration * 0.9)) continue;

    const bin0 = Math.floor(start);
    const bin1 = Math.min(energy.length, Math.ceil(end));
    const slice = energy.slice(bin0, bin1);
    if (slice.length === 0) continue;

    const sliceStats = energyStats(slice);
    const energyScore = clamp01(0.5 + (sliceStats.mean - stats.mean) / (2 * (stats.std || 1)));
    const dynamics = clamp01(sliceStats.std / ((stats.std || 1) * 1.5));
    const speech = clamp01(
      slice.filter((v) => v > speechFloor).length / slice.length,
    );
    const cleanStart = proximityScore(start, anchors, 2.5);
    const cleanEnd = proximityScore(end, [...silenceStarts, ...analysis.sceneChanges], 3);

    let cue = 0;
    let windowText = "";
    if (options.transcript?.length) {
      windowText = options.transcript
        .filter((s) => s.startTime < end && s.endTime > start)
        .map((s) => s.text)
        .join(" ");
      const lower = windowText.toLowerCase();
      const hits = CUE_WORDS.reduce((n, w) => (lower.includes(w) ? n + 1 : n), 0);
      cue = clamp01(hits / 3);
    }

    const total =
      100 *
      (0.28 * energyScore +
        0.14 * dynamics +
        0.16 * cleanStart +
        0.1 * cleanEnd +
        0.22 * speech +
        0.1 * cue);

    windows.push({
      startTime: start,
      endTime: end,
      score: Math.round(total),
      title: "",
      hook: null,
      reason: "",
      category: "auto",
      confidence: 0,
      parts: { energy: energyScore, dynamics, cleanStart, cleanEnd, speech, cue },
    });
  }

  windows.sort((a, b) => b.score - a.score);
  const picked = nonOverlapping(windows, options.count, 0.35);

  return picked.map((w) => {
    const snapped = snapToBoundaries(w, options.transcript, anchors, silenceStarts, duration);
    const text = options.transcript
      ?.filter((s) => s.startTime < snapped.endTime && s.endTime > snapped.startTime)
      .map((s) => s.text.trim())
      .join(" ");
    return {
      startTime: round1(snapped.startTime),
      endTime: round1(snapped.endTime),
      score: w.score,
      title: makeTitle(text, snapped.startTime),
      hook: text ? truncate(text, 110) : null,
      reason: makeReason(w),
      category: w.parts.cue > 0.3 ? "educational" : "auto",
      confidence: clamp01(0.5 + w.score / 400 + (text ? 0.1 : 0)),
    };
  });
}

function energyStats(values: number[]): { mean: number; std: number } {
  if (values.length === 0) return { mean: -60, std: 1 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return { mean, std: Math.sqrt(variance) || 1 };
}

/** 1 when x sits on an anchor, decaying to 0 at `radius` seconds away. */
function proximityScore(x: number, anchors: number[], radius: number): number {
  let best = Infinity;
  for (const a of anchors) {
    const d = Math.abs(a - x);
    if (d < best) best = d;
  }
  if (!Number.isFinite(best)) return 0.4; // no anchors — neutral
  return clamp01(1 - best / radius);
}

function nonOverlapping<T extends { startTime: number; endTime: number }>(
  sorted: T[],
  count: number,
  maxOverlapRatio: number,
): T[] {
  const picked: T[] = [];
  for (const w of sorted) {
    if (picked.length >= count) break;
    const overlaps = picked.some((p) => {
      const overlap =
        Math.min(p.endTime, w.endTime) - Math.max(p.startTime, w.startTime);
      const shorter = Math.min(
        p.endTime - p.startTime,
        w.endTime - w.startTime,
      );
      return overlap > shorter * maxOverlapRatio;
    });
    if (!overlaps) picked.push(w);
  }
  return picked;
}

function snapToBoundaries(
  w: { startTime: number; endTime: number },
  transcript: TranscriptSegmentLite[] | undefined,
  startAnchors: number[],
  endAnchors: number[],
  duration: number,
): { startTime: number; endTime: number } {
  let start = w.startTime;
  let end = w.endTime;

  if (transcript?.length) {
    // Never cut mid-sentence: start at a segment start, end at a segment end
    const startSeg = [...transcript]
      .reverse()
      .find((s) => s.startTime <= start + 2.5 && s.startTime >= start - 3.5);
    if (startSeg) start = startSeg.startTime;
    const endSeg = transcript.find(
      (s) => s.endTime >= end - 2.5 && s.endTime <= end + 3.5,
    );
    if (endSeg) end = endSeg.endTime;
  } else {
    const near = (x: number, anchors: number[], radius: number) => {
      let best: number | null = null;
      for (const a of anchors) {
        if (Math.abs(a - x) <= radius && (best === null || Math.abs(a - x) < Math.abs(best - x))) {
          best = a;
        }
      }
      return best;
    };
    start = near(start, startAnchors, 2) ?? start;
    end = near(end, endAnchors, 2.5) ?? end;
  }

  start = Math.max(0, start);
  end = Math.min(duration, end);
  if (end - start < 10) end = Math.min(duration, start + 10);
  return { startTime: start, endTime: end };
}

function makeTitle(text: string | undefined, start: number): string {
  if (text) {
    const sentence = text.split(/(?<=[.!?])\s+/)[0] ?? text;
    return truncate(sentence.replace(/^[a-z]/, (c) => c.toUpperCase()), 64);
  }
  const m = Math.floor(start / 60);
  const s = Math.floor(start % 60);
  return `Moment at ${m}:${String(s).padStart(2, "0")}`;
}

function makeReason(w: ScoredWindow): string {
  const bits: string[] = [];
  if (w.parts.energy > 0.6) bits.push("high vocal energy");
  if (w.parts.dynamics > 0.6) bits.push("dynamic delivery");
  if (w.parts.speech > 0.8) bits.push("continuous speech with little dead air");
  if (w.parts.cleanStart > 0.6) bits.push("starts right after a natural pause");
  if (w.parts.cleanEnd > 0.6) bits.push("ends on a clean boundary");
  if (w.parts.cue > 0.3) bits.push("contains hook phrases");
  if (bits.length === 0) bits.push("strongest available section of the source");
  return `Selected by signal analysis: ${bits.join(", ")}.`;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`;
}
