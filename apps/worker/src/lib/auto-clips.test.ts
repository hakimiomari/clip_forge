import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReelParts } from "@clipforge/shared-types";
import { captionsForParts, captionsForWindow } from "./auto-clips";

const transcript = [
  { startTime: 0, endTime: 4, text: "before the window" },
  { startTime: 9, endTime: 12, text: "straddles the start" },
  { startTime: 13, endTime: 15, text: "fully inside" },
  { startTime: 19, endTime: 24, text: "straddles the end" },
  { startTime: 30, endTime: 33, text: "after the window" },
];

test("captions are re-timed to the clip and clipped to its edges", () => {
  // Window 10–20 becomes a clip running 0–10
  assert.deepEqual(captionsForWindow(transcript, 10, 20), [
    { startTime: 0, endTime: 2, text: "straddles the start" },
    { startTime: 3, endTime: 5, text: "fully inside" },
    { startTime: 9, endTime: 10, text: "straddles the end" },
  ]);
});

test("lines outside the window are dropped", () => {
  const lines = captionsForWindow(transcript, 25, 29);
  assert.equal(lines.length, 0);
});

test("a source with no transcript yields no captions", () => {
  assert.deepEqual(captionsForWindow([], 0, 30), []);
});

test("captionsForParts places each part's lines after the parts before it", () => {
  const lines = captionsForParts(transcript, [
    { start: 13, end: 15 },
    { start: 30, end: 33 },
  ]);
  assert.deepEqual(lines, [
    { startTime: 0, endTime: 2, text: "fully inside" },
    // Second part starts 2s into the stitched video
    { startTime: 2, endTime: 5, text: "after the window" },
  ]);
});

test("buildReelParts: best non-overlapping moments, in story order", () => {
  const parts = buildReelParts(
    [
      { start: 300, end: 315, score: 90 },
      { start: 305, end: 320, score: 85 }, // overlaps the best one
      { start: 100, end: 115, score: 80 },
      { start: 500, end: 515, score: 70 },
      { start: 50, end: 65, score: 10 },
    ],
    45,
  );
  assert.deepEqual(
    parts.map((p) => p.start),
    [100, 300, 500],
  );
});

test("buildReelParts stops near the target length", () => {
  const moments = Array.from({ length: 10 }, (_, i) => ({
    start: i * 100,
    end: i * 100 + 15,
    score: 100 - i,
  }));
  const parts = buildReelParts(moments, 60);
  const total = parts.reduce((sum, p) => sum + (p.end - p.start), 0);
  assert.equal(total, 60);
});
