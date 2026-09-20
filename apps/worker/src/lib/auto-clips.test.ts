import { test } from "node:test";
import assert from "node:assert/strict";
import { captionsForWindow } from "./auto-clips";

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
