import { completeText, extractJson } from "./llm";
import type { HighlightCandidate, TranscriptSegmentLite } from "./heuristics";

/**
 * LLM-backed Highlight Selection Agent. Receives the timestamped
 * transcript and returns scored clip candidates following the PRD rubric.
 * Falls back to heuristics upstream when unavailable or on failure.
 */

const RUBRIC = `Score each candidate 0-100 using this weighting:
- Hook strength (first ~3 seconds grabs attention): 25%
- Standalone context (understandable without the rest of the video): 20%
- Information value: 20%
- Emotional or entertainment value: 15%
- Visual interest (topic changes, energy): 10%
- Audio quality (complete fluent speech, no fragments): 5%
- Ending quality (clean conclusion, no mid-sentence cut): 5%`;

export async function selectHighlightsWithLlm(options: {
  transcript: TranscriptSegmentLite[];
  duration: number;
  targetLength: number;
  count: number;
}): Promise<HighlightCandidate[]> {
  const { transcript, duration, targetLength, count } = options;

  const lines = transcript.map(
    (s) => `[${s.startTime.toFixed(1)}-${s.endTime.toFixed(1)}] ${s.text.trim()}`,
  );
  // Keep the prompt bounded for very long sources
  let body = lines.join("\n");
  if (body.length > 60_000) {
    body = `${body.slice(0, 60_000)}\n[transcript truncated]`;
  }

  const prompt = `You are the highlight selection agent of a short-form video tool.
The user owns this content. Find the ${count} best self-contained moments of about ${targetLength} seconds (acceptable range ${Math.round(targetLength * 0.7)}-${Math.round(targetLength * 1.3)}s) in a ${Math.round(duration)}s video.

${RUBRIC}

Hard rules:
- startTime/endTime must align with the transcript timestamps below; never start or end mid-sentence.
- Clips must not overlap by more than a few seconds.
- Prefer moments that begin with a strong hook line.
- "title" is a short punchy label (max 8 words). "hook" quotes or paraphrases the opening line. "reason" explains the selection in one sentence. "category" is one of: educational, funny, emotional, inspirational, story, interview, business, technology, motivational, other.

Respond with ONLY this JSON:
{"clips":[{"startTime":0,"endTime":0,"score":0,"title":"","hook":"","reason":"","category":"","confidence":0.0}]}

Transcript:
${body}`;

  const raw = await completeText(prompt);
  const parsed = extractJson<{ clips?: unknown[] }>(raw);
  if (!Array.isArray(parsed.clips)) {
    throw new Error("LLM response missing clips array");
  }

  const segStarts = transcript.map((s) => s.startTime);
  const segEnds = transcript.map((s) => s.endTime);

  const cleaned: HighlightCandidate[] = [];
  for (const item of parsed.clips) {
    const c = item as Record<string, unknown>;
    let start = Number(c.startTime);
    let end = Number(c.endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    // Snap to sentence boundaries as a safety net
    start = nearest(segStarts, start, 4) ?? start;
    end = nearest(segEnds, end, 4) ?? end;
    start = Math.max(0, start);
    end = Math.min(duration, end);
    if (end - start < 8) continue;
    cleaned.push({
      startTime: Math.round(start * 10) / 10,
      endTime: Math.round(end * 10) / 10,
      score: clampNumber(Number(c.score), 0, 100, 60),
      title: String(c.title ?? "Highlight").slice(0, 80),
      hook: c.hook ? String(c.hook).slice(0, 160) : null,
      reason: String(c.reason ?? "Selected by AI analysis").slice(0, 300),
      category: String(c.category ?? "other").slice(0, 40),
      confidence: clampNumber(Number(c.confidence), 0, 1, 0.7),
    });
  }
  if (cleaned.length === 0) {
    throw new Error("LLM returned no usable clip candidates");
  }
  cleaned.sort((a, b) => b.score - a.score);
  return cleaned.slice(0, count);
}

function nearest(values: number[], x: number, radius: number): number | null {
  let best: number | null = null;
  for (const v of values) {
    if (Math.abs(v - x) <= radius && (best === null || Math.abs(v - x) < Math.abs(best - x))) {
      best = v;
    }
  }
  return best;
}

function clampNumber(x: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, x));
}
