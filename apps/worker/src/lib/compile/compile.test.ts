import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCompilationCredits,
  chooseMoments,
  type CompilationMoment,
} from "@clipforge/shared-types";
import { escapeDrawText } from "./assemble";

const moment = (
  videoId: string,
  start: number,
  score: number,
  seconds = 12,
): CompilationMoment => ({
  videoId,
  videoTitle: `Video ${videoId}`,
  channel: `Channel ${videoId}`,
  start,
  end: start + seconds,
  score,
  watchUrl: `https://www.youtube.com/watch?v=${videoId}`,
});

test("stops once the target length is reached", () => {
  const picked = chooseMoments(
    [moment("a", 0, 90), moment("b", 0, 80), moment("c", 0, 70), moment("d", 0, 60)],
    30,
  );
  const total = picked.reduce((s, m) => s + (m.end - m.start), 0);
  assert.ok(total >= 30, `total ${total}`);
  assert.equal(picked.length, 3);
});

test("one video cannot fill the whole compilation", () => {
  // Video "a" has the three best moments, but a best-of should be varied
  const picked = chooseMoments(
    [
      moment("a", 0, 99),
      moment("a", 60, 98),
      moment("a", 120, 97),
      moment("b", 0, 50),
      moment("c", 0, 40),
    ],
    36,
  );
  const fromA = picked.filter((m) => m.videoId === "a").length;
  assert.equal(fromA, 1, "only a's best on the first pass");
  assert.deepEqual(
    picked.map((m) => m.videoId).sort(),
    ["a", "b", "c"],
  );
});

test("returns to a video for a second moment when the others run out", () => {
  const picked = chooseMoments(
    [moment("a", 0, 99), moment("a", 60, 98), moment("b", 0, 50)],
    36,
  );
  assert.equal(picked.length, 3);
  assert.equal(picked.filter((m) => m.videoId === "a").length, 2);
});

test("an empty candidate list yields an empty compilation", () => {
  assert.deepEqual(chooseMoments([], 60), []);
});

test("credits list each source video once", () => {
  const credits = buildCompilationCredits([
    moment("a", 0, 99),
    moment("a", 60, 98),
    moment("b", 0, 50),
  ]);
  const lines = credits.split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /Video a — Channel a \(https:\/\/www\.youtube\.com\/watch\?v=a\)/);
});

test("on-screen credit text is safe for ffmpeg's drawtext", () => {
  const safe = escapeDrawText("It's 100%: {wow} \\ back");
  assert.ok(!/['%{}\\]/.test(safe), safe);
  assert.ok(!safe.includes(":"), "colons would end the drawtext option");
  assert.ok(escapeDrawText("x".repeat(200)).length <= 70);
});

test("the highlight scorer returns moments shorter than a standalone clip", async () => {
  const { selectHighlights } = await import("../heuristics");
  // 5 minutes of audio with one loud burst around 2:00
  const energy = Array.from({ length: 300 }, (_, i) => (i >= 118 && i < 132 ? -12 : -38));
  const analysis = { energyPerSecond: energy, silences: [], sceneChanges: [] };

  // The default 15s floor rejects every 12s window — this is the bug
  // that made every compilation come back empty
  const strict = selectHighlights({ duration: 300, targetLength: 12, count: 2, analysis });
  assert.equal(strict.length, 0);

  const relaxed = selectHighlights({
    duration: 300,
    targetLength: 12,
    count: 2,
    analysis,
    minWindowSeconds: 10,
  });
  assert.ok(relaxed.length > 0, "short moments are found once the floor is lowered");
  // And it finds the loud part, not an arbitrary window
  const best = relaxed[0]!;
  assert.ok(best.startTime < 132 && best.endTime > 118, `${best.startTime}-${best.endTime}`);
});
