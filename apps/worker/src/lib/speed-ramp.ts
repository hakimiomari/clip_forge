import type { SpeedKeyframe, SpeedRampEffect } from "@clipforge/shared-types";
import type { SpeedSegment } from "./time-map";

/**
 * Speed-ramp sampler: turns a keyframed velocity curve into the
 * constant-speed sub-segments the FFmpeg speed chain consumes.
 *
 * Between keyframes the playback speed transitions with configurable
 * easing (linear → smootherstep). Ramps are sampled into short steps —
 * at render frame rates a 10-step staircase over a ramp is visually
 * indistinguishable from a continuous curve, while keeping video
 * (trim/setpts) and audio (atempo) exactly in sync per step.
 */

const MAX_SEGMENTS = 64;
/** Below this speed and above this length, frame synthesis kicks in */
const INTERPOLATE_SPEED_THRESHOLD = 0.7;
const INTERPOLATE_MIN_SECONDS = 0.25;

function smootherstep(u: number): number {
  const x = Math.max(0, Math.min(1, u));
  return x * x * x * (x * (x * 6 - 15) + 10);
}

/** Eased speed at normalized position u within one keyframe interval. */
export function easedSpeed(
  from: number,
  to: number,
  u: number,
  smoothness: number,
): number {
  const sm = Math.max(0, Math.min(1, smoothness));
  const eased = (1 - sm) * Math.max(0, Math.min(1, u)) + sm * smootherstep(u);
  return from + (to - from) * eased;
}

/** The continuous speed curve s(t) defined by the effect. */
export function speedAt(effect: SpeedRampEffect, t: number): number {
  const kfs = sortedKeyframes(effect);
  const first = kfs[0]!;
  const last = kfs[kfs.length - 1]!;
  if (t <= first.t) return first.speed;
  if (t >= last.t) return last.speed;
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i]!;
    const b = kfs[i + 1]!;
    if (t <= b.t) {
      const span = Math.max(0.001, b.t - a.t);
      return easedSpeed(a.speed, b.speed, (t - a.t) / span, effect.smoothness);
    }
  }
  return last.speed;
}

function sortedKeyframes(effect: SpeedRampEffect): SpeedKeyframe[] {
  return [...effect.keyframes].sort((a, b) => a.t - b.t);
}

/**
 * Samples the curve into SpeedSegments covering [0, clipDuration].
 * Constant stretches stay single segments; ramps are subdivided.
 */
export function sampleSpeedRamp(
  effect: SpeedRampEffect,
  clipDuration: number,
): SpeedSegment[] {
  const kfs = sortedKeyframes(effect).map((k) => ({
    t: Math.max(0, Math.min(clipDuration, k.t)),
    speed: clampSpeed(k.speed),
  }));
  const segments: SpeedSegment[] = [];

  const push = (srcStart: number, srcEnd: number, speed: number) => {
    if (srcEnd - srcStart < 0.02) return;
    const rounded = Math.round(speed * 1000) / 1000;
    const prev = segments[segments.length - 1];
    if (prev && Math.abs(prev.speed - rounded) < 0.011 && !prev.holdSeconds) {
      prev.srcEnd = srcEnd; // merge equal-speed neighbours
      return;
    }
    segments.push({ srcStart, srcEnd, speed: rounded });
  };

  const first = kfs[0]!;
  const last = kfs[kfs.length - 1]!;
  push(0, first.t, first.speed);

  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i]!;
    const b = kfs[i + 1]!;
    const len = b.t - a.t;
    if (len < 0.02) continue;
    if (Math.abs(a.speed - b.speed) < 0.011) {
      push(a.t, b.t, a.speed);
      continue;
    }
    // Subdivide the ramp; per-step speed sampled at the step midpoint
    const steps = Math.min(12, Math.max(4, Math.ceil(len / 0.15)));
    for (let sIdx = 0; sIdx < steps; sIdx++) {
      const t0 = a.t + (len * sIdx) / steps;
      const t1 = a.t + (len * (sIdx + 1)) / steps;
      const mid = (t0 + t1) / 2;
      push(t0, t1, speedAt(effect, mid));
    }
  }

  push(last.t, clipDuration, last.speed);

  // Safety: coalesce if pathological input produced too many segments
  while (segments.length > MAX_SEGMENTS) {
    for (let i = 0; i < segments.length - 1; i += 1) {
      const a = segments[i]!;
      const b = segments[i + 1]!;
      if (Math.abs(a.speed - b.speed) < 0.1) {
        a.srcEnd = b.srcEnd;
        a.speed = (a.speed + b.speed) / 2;
        segments.splice(i + 1, 1);
      }
    }
    break;
  }

  // Flags: frame synthesis on slow sections, mute below the threshold
  const mode =
    effect.interpolation === "blend"
      ? ("blend" as const)
      : effect.interpolation === "optical_flow"
        ? ("mci" as const)
        : undefined;
  for (const seg of segments) {
    const dur = seg.srcEnd - seg.srcStart;
    if (
      mode &&
      seg.speed < INTERPOLATE_SPEED_THRESHOLD &&
      dur / seg.speed >= INTERPOLATE_MIN_SECONDS
    ) {
      seg.interpolate = mode;
    }
    if (effect.muteBelowSpeed > 0 && seg.speed < effect.muteBelowSpeed) {
      seg.mute = true;
    }
  }
  return segments;
}

function clampSpeed(s: number): number {
  return Math.max(0.05, Math.min(4, s));
}
