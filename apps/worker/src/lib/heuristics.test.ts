import test from "node:test";
import assert from "node:assert/strict";
import { selectHighlights } from "./heuristics";
import type { MediaAnalysis } from "./analysis";

function syntheticAnalysis(duration: number): MediaAnalysis {
  // Loud speech in [60,120] and [200,260], quiet elsewhere
  const energyPerSecond = Array.from({ length: duration }, (_, t) =>
    (t >= 60 && t < 120) || (t >= 200 && t < 260) ? -18 + Math.sin(t) * 3 : -55,
  );
  return {
    energyPerSecond,
    silences: [
      { start: 55, end: 59.5 },
      { start: 120, end: 130 },
      { start: 195, end: 199.5 },
    ],
    sceneChanges: [60, 120, 200],
  };
}

void test("selectHighlights finds the loud sections", () => {
  const highlights = selectHighlights({
    duration: 300,
    targetLength: 45,
    count: 2,
    analysis: syntheticAnalysis(300),
  });
  assert.equal(highlights.length, 2);
  for (const h of highlights) {
    const mid = (h.startTime + h.endTime) / 2;
    const inLoudZone =
      (mid > 55 && mid < 130) || (mid > 195 && mid < 265);
    assert.ok(inLoudZone, `highlight midpoint ${mid} should be in a loud zone`);
    assert.ok(h.endTime - h.startTime >= 10);
    assert.ok(h.score >= 0 && h.score <= 100);
    assert.ok(h.title.length > 0);
  }
});

void test("selectHighlights returns non-overlapping windows", () => {
  const highlights = selectHighlights({
    duration: 300,
    targetLength: 60,
    count: 3,
    analysis: syntheticAnalysis(300),
  });
  for (let i = 0; i < highlights.length; i++) {
    for (let j = i + 1; j < highlights.length; j++) {
      const a = highlights[i]!;
      const b = highlights[j]!;
      const overlap =
        Math.min(a.endTime, b.endTime) - Math.max(a.startTime, b.startTime);
      const shorter = Math.min(a.endTime - a.startTime, b.endTime - b.startTime);
      assert.ok(
        overlap <= shorter * 0.35 + 0.001,
        `highlights ${i} and ${j} overlap too much (${overlap}s)`,
      );
    }
  }
});

void test("selectHighlights snaps to transcript sentence boundaries", () => {
  const transcript = [
    { startTime: 58, endTime: 65, text: "Here is the biggest mistake people make." },
    { startTime: 65, endTime: 80, text: "They never check their assumptions first." },
    { startTime: 80, endTime: 100, text: "Let me show you exactly how to fix it." },
    { startTime: 100, endTime: 118, text: "And that is why it matters so much." },
  ];
  const [h] = selectHighlights({
    duration: 300,
    targetLength: 60,
    count: 1,
    analysis: syntheticAnalysis(300),
    transcript,
  });
  assert.ok(h);
  const starts = transcript.map((s) => s.startTime);
  const ends = transcript.map((s) => s.endTime);
  const startsOnBoundary = starts.some((s) => Math.abs(s - h.startTime) < 0.01);
  const endsOnBoundary = ends.some((e) => Math.abs(e - h.endTime) < 0.01);
  assert.ok(startsOnBoundary || endsOnBoundary, "should snap to at least one sentence boundary");
  assert.ok(h.hook, "transcript-based highlights carry a hook");
});

void test("selectHighlights handles empty/short media", () => {
  assert.deepEqual(
    selectHighlights({
      duration: 0,
      targetLength: 60,
      count: 3,
      analysis: { energyPerSecond: [], silences: [], sceneChanges: [] },
    }),
    [],
  );
});
