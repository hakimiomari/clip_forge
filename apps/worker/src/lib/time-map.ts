import type { RangeEffect } from "@clipforge/shared-types";
// Value import is safe: speed-ramp only imports types from this module
import { sampleSpeedRamp } from "./speed-ramp";

/**
 * Speed effects (slow motion, speed-up, freeze) stretch or shrink parts
 * of the clip, so everything expressed in original clip time (captions,
 * gated color effects, trail keyframes) must be re-timed. TimeMap models
 * the piecewise-linear original→output mapping.
 */

export interface SpeedSegment {
  /** Original clip time range this segment covers */
  srcStart: number;
  srcEnd: number;
  /** Playback speed (1 = realtime). 0 marks a freeze-frame hold. */
  speed: number;
  /** Hold length for freeze segments */
  holdSeconds?: number;
  /** Frame synthesis for slowed sections (speed ramps) */
  interpolate?: "blend" | "mci";
  /** Silence this segment's audio (deep-slow sections) */
  mute?: boolean;
}

export interface TimeMap {
  segments: SpeedSegment[];
  outputDuration: number;
  /** Maps a timestamp in original clip time to output time */
  toOutput(t: number): number;
  hasSpeedChanges: boolean;
}

type SpeedEffect = Extract<
  RangeEffect,
  { type: "slow_motion" | "speed_up" | "freeze_frame" }
>;

export function isSpeedEffect(e: RangeEffect): e is SpeedEffect {
  return (
    e.type === "slow_motion" || e.type === "speed_up" || e.type === "freeze_frame"
  );
}

/**
 * Builds the segment list covering [0, clipDuration]. Overlapping speed
 * effects are rejected upstream (API validation); here they are sorted
 * and clamped defensively.
 */
export function buildTimeMap(
  effects: RangeEffect[] | undefined,
  clipDuration: number,
): TimeMap {
  // A speed ramp defines the whole velocity curve — it supersedes the
  // simple range speed effects (validation enforces exclusivity).
  const ramp = (effects ?? []).find((e) => e.type === "speed_ramp");
  if (ramp && ramp.type === "speed_ramp") {
    return makeTimeMap(sampleSpeedRamp(ramp, clipDuration), clipDuration);
  }

  const speedEffects = (effects ?? [])
    .filter(isSpeedEffect)
    .map((e) => ({
      start: clamp(e.start, 0, clipDuration),
      end:
        e.type === "freeze_frame"
          ? clamp(e.start, 0, clipDuration)
          : clamp(e.end, 0, clipDuration),
      speed: e.type === "slow_motion" || e.type === "speed_up" ? e.factor : 0,
      holdSeconds: e.type === "freeze_frame" ? e.holdSeconds : undefined,
    }))
    .filter((e) => e.speed === 0 || e.end - e.start > 0.05)
    .sort((a, b) => a.start - b.start);

  const segments: SpeedSegment[] = [];
  let cursor = 0;
  for (const e of speedEffects) {
    if (e.start > cursor + 0.001) {
      segments.push({ srcStart: cursor, srcEnd: e.start, speed: 1 });
    }
    if (e.speed === 0) {
      segments.push({
        srcStart: e.start,
        srcEnd: e.start,
        speed: 0,
        holdSeconds: e.holdSeconds ?? 1,
      });
      cursor = Math.max(cursor, e.start);
    } else {
      segments.push({ srcStart: Math.max(cursor, e.start), srcEnd: e.end, speed: e.speed });
      cursor = e.end;
    }
  }
  if (cursor < clipDuration - 0.001 || segments.length === 0) {
    segments.push({ srcStart: cursor, srcEnd: clipDuration, speed: 1 });
  }

  return makeTimeMap(segments, clipDuration);
}

/** Builds the map (offsets, output duration, remap fn) from segments. */
export function makeTimeMap(
  segments: SpeedSegment[],
  clipDuration: number,
): TimeMap {
  // Precompute output offsets per segment
  const offsets: number[] = [];
  let out = 0;
  for (const s of segments) {
    offsets.push(out);
    out += s.speed === 0 ? (s.holdSeconds ?? 1) : (s.srcEnd - s.srcStart) / s.speed;
  }
  const outputDuration = out;

  const toOutput = (t: number): number => {
    const clamped = clamp(t, 0, clipDuration);
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i]!;
      const base = offsets[i]!;
      if (s.speed === 0) {
        if (clamped <= s.srcStart) return base;
        continue;
      }
      if (clamped <= s.srcEnd || i === segments.length - 1) {
        if (clamped < s.srcStart) return base;
        return base + (clamped - s.srcStart) / s.speed;
      }
    }
    return outputDuration;
  };

  return {
    segments,
    outputDuration,
    toOutput,
    hasSpeedChanges:
      segments.length > 1 || (segments[0] !== undefined && segments[0].speed !== 1),
  };
}

function clamp(x: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, x));
}
