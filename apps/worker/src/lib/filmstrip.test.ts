import { test } from "node:test";
import assert from "node:assert/strict";
import { frameTime, planFilmstrip } from "./filmstrip";

test("planFilmstrip keeps the sprite within bounds at any duration", () => {
  // Short clip: still enough frames to read the timeline
  const short = planFilmstrip(19);
  assert.equal(short.count, 24);
  assert.equal(short.columns, 12);
  assert.equal(short.rows, 2);

  // Feature-length source: capped so the sprite stays small
  const long = planFilmstrip(3 * 3600);
  assert.equal(long.count, 120);
  assert.equal(long.rows, 10);

  for (const seconds of [1, 30, 600, 4 * 3600]) {
    const plan = planFilmstrip(seconds);
    assert.ok(plan.count >= 24 && plan.count <= 120, `count for ${seconds}s`);
    assert.ok(plan.rows * plan.columns >= plan.count, `grid fits ${seconds}s`);
    assert.ok(plan.interval > 0);
  }
});

test("frames are sampled inside their slice, never at 0 or past the end", () => {
  const duration = 100;
  const plan = planFilmstrip(duration);
  const first = frameTime(0, plan);
  const last = frameTime(plan.count - 1, plan);
  assert.ok(first > 0, "first frame is not the black frame at 0s");
  assert.ok(last < duration, "last frame is inside the video");
  // Evenly spaced, so a time maps back to the frame drawn under it
  const mid = frameTime(10, plan);
  assert.equal(Math.round(mid / plan.interval - 0.5), 10);
});
