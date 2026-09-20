import test from "node:test";
import assert from "node:assert/strict";
import { buildTimeMap } from "./time-map";
import type { RangeEffect } from "@clipforge/shared-types";

const close = (a: number, b: number, eps = 0.01) =>
  assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

void test("no effects → identity map", () => {
  const map = buildTimeMap([], 30);
  assert.equal(map.hasSpeedChanges, false);
  close(map.outputDuration, 30);
  close(map.toOutput(12.5), 12.5);
});

void test("slow motion stretches its range and shifts what follows", () => {
  const effects: RangeEffect[] = [
    { id: "a", type: "slow_motion", start: 10, end: 13, factor: 0.5 },
  ];
  const map = buildTimeMap(effects, 30);
  assert.equal(map.hasSpeedChanges, true);
  // 3s at half speed becomes 6s → total 33s
  close(map.outputDuration, 33);
  close(map.toOutput(5), 5); // before: unchanged
  close(map.toOutput(11.5), 13); // middle of slowmo: 10 + 1.5/0.5
  close(map.toOutput(13), 16); // end of slowmo
  close(map.toOutput(20), 23); // after: shifted by +3
});

void test("speed-up compresses", () => {
  const map = buildTimeMap(
    [{ id: "a", type: "speed_up", start: 0, end: 10, factor: 2 }],
    30,
  );
  close(map.outputDuration, 25);
  close(map.toOutput(10), 5);
  close(map.toOutput(30), 25);
});

void test("freeze frame inserts a hold", () => {
  const map = buildTimeMap(
    [{ id: "a", type: "freeze_frame", start: 5, holdSeconds: 2 }],
    20,
  );
  close(map.outputDuration, 22);
  close(map.toOutput(4), 4);
  close(map.toOutput(5), 5); // boundary maps to hold start
  close(map.toOutput(10), 12); // after freeze: +2
});

void test("multiple effects compose in order", () => {
  const map = buildTimeMap(
    [
      { id: "b", type: "speed_up", start: 20, end: 28, factor: 2 },
      { id: "a", type: "slow_motion", start: 2, end: 4, factor: 0.5 },
    ],
    30,
  );
  // +2 from slowmo, -4 from speedup
  close(map.outputDuration, 28);
  close(map.toOutput(30), 28);
  close(map.toOutput(3), 4); // inside slowmo
  close(map.toOutput(24), 24); // inside speedup: 22 + 4/2 = 24 → 20+2(shift)+2 = 24
});
