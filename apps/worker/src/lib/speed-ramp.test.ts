import test from "node:test";
import assert from "node:assert/strict";
import type { SpeedRampEffect } from "@clipforge/shared-types";
import { speedRampPreset } from "@clipforge/shared-types";
import { easedSpeed, sampleSpeedRamp, speedAt } from "./speed-ramp";
import { buildTimeMap } from "./time-map";
import { buildSpeedChain } from "./effects";

const ramp = (over?: Partial<SpeedRampEffect>): SpeedRampEffect => ({
  id: "r1",
  type: "speed_ramp",
  keyframes: [
    { t: 5, speed: 1 },
    { t: 7, speed: 0.1 },
    { t: 10, speed: 0.1 },
    { t: 12, speed: 2 },
  ],
  smoothness: 1,
  interpolation: "blend",
  muteBelowSpeed: 0.25,
  ...over,
});

void test("speedAt holds edge speeds and passes through keyframes", () => {
  const e = ramp();
  assert.equal(speedAt(e, 0), 1); // before first kf
  assert.equal(speedAt(e, 20), 2); // after last kf
  assert.ok(Math.abs(speedAt(e, 7) - 0.1) < 0.001);
  assert.ok(Math.abs(speedAt(e, 8.5) - 0.1) < 0.001); // plateau
});

void test("eased ramps differ from linear at the quarter point", () => {
  const linear = easedSpeed(1, 0.1, 0.25, 0);
  const eased = easedSpeed(1, 0.1, 0.25, 1);
  // smootherstep starts slower: still closer to the start speed at u=0.25
  assert.ok(eased > linear);
});

void test("sampler covers the clip exactly and subdivides ramps only", () => {
  const segs = sampleSpeedRamp(ramp(), 20);
  assert.ok(Math.abs(segs[0]!.srcStart - 0) < 0.001);
  assert.ok(Math.abs(segs[segs.length - 1]!.srcEnd - 20) < 0.001);
  for (let i = 1; i < segs.length; i++) {
    assert.ok(
      Math.abs(segs[i]!.srcStart - segs[i - 1]!.srcEnd) < 0.001,
      "segments must be contiguous",
    );
  }
  // Plateau 7–10 at 0.1 stays a single segment; ramps are multi-step
  const plateau = segs.find((s) => s.srcStart <= 8 && s.srcEnd >= 9);
  assert.ok(plateau && Math.abs(plateau.speed - 0.1) < 0.02);
  assert.ok(segs.length >= 8 && segs.length <= 64);
});

void test("deep-slow segments get synthesis and mute flags", () => {
  const segs = sampleSpeedRamp(ramp(), 20);
  const slow = segs.filter((s) => s.speed < 0.25);
  assert.ok(slow.length > 0);
  assert.ok(slow.every((s) => s.mute === true), "deep-slow audio is muted");
  const plateau = segs.find((s) => s.srcStart <= 8 && s.srcEnd >= 9)!;
  assert.equal(plateau.interpolate, "blend");
});

void test("optical_flow maps to mci and dup disables synthesis", () => {
  const mci = sampleSpeedRamp(ramp({ interpolation: "optical_flow" }), 20);
  assert.ok(mci.some((s) => s.interpolate === "mci"));
  const dup = sampleSpeedRamp(ramp({ interpolation: "dup" }), 20);
  assert.ok(dup.every((s) => s.interpolate === undefined));
});

void test("time map integrates the ramp into a longer output", () => {
  const map = buildTimeMap([ramp()], 20);
  assert.equal(map.hasSpeedChanges, true);
  // 3s plateau at 0.1x alone adds ~27s of output
  assert.ok(map.outputDuration > 40, `expected > 40s, got ${map.outputDuration}`);
  // Monotonic remap
  let prev = -1;
  for (let t = 0; t <= 20; t += 0.5) {
    const o = map.toOutput(t);
    assert.ok(o >= prev - 0.001, "toOutput must be monotonic");
    prev = o;
  }
});

void test("speed chain renders synthesis and mute into the filtergraph", () => {
  const map = buildTimeMap([ramp()], 20);
  const graph = buildSpeedChain(map, true).chains.join(";");
  assert.match(graph, /minterpolate=fps=30:mi_mode=blend/);
  assert.match(graph, /,volume=0\[sa/);
  assert.match(graph, /concat=n=\d+:v=1:a=1/);
});

void test("presets produce valid ascending keyframes", () => {
  for (const name of ["hero_moment", "bullet_time"] as const) {
    const kfs = speedRampPreset(name, 10, 30);
    assert.ok(kfs.length >= 4);
    for (let i = 1; i < kfs.length; i++) {
      assert.ok(kfs[i]!.t >= kfs[i - 1]!.t, "times ascend");
    }
    assert.ok(kfs.every((k) => k.speed >= 0.05 && k.speed <= 4));
  }
});
