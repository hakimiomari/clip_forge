import { BadRequestException } from "@nestjs/common";
import type { RangeEffect } from "@clipforge/shared-types";

/**
 * Validates the advanced-effects array against the clip's duration.
 * Effects are free-form JSON from the editor, so validation is explicit
 * rather than DTO-decorator based.
 */

const COLOR_PRESETS = new Set([
  "cinematic",
  "warm",
  "cool",
  "black_white",
  "vivid",
]);

const MAX_EFFECTS = 12;

export function validateRangeEffects(
  input: unknown,
  clipDuration: number,
): RangeEffect[] {
  if (!Array.isArray(input)) {
    throw new BadRequestException("effects must be an array");
  }
  if (input.length > MAX_EFFECTS) {
    throw new BadRequestException(`At most ${MAX_EFFECTS} effects per clip`);
  }

  const out: RangeEffect[] = [];
  let trailCount = 0;

  for (const [i, raw] of input.entries()) {
    const e = raw as Record<string, unknown>;
    const fail = (msg: string) => {
      throw new BadRequestException(`Effect ${i + 1}: ${msg}`);
    };
    const num = (v: unknown, name: string): number => {
      const n = Number(v);
      if (!Number.isFinite(n)) fail(`${name} must be a number`);
      return n;
    };
    const inClip = (t: number, name: string): number => {
      if (t < 0 || t > clipDuration + 0.01) {
        fail(`${name} (${t}s) is outside the clip (0–${clipDuration.toFixed(1)}s)`);
      }
      return Math.round(t * 100) / 100;
    };
    const id =
      typeof e.id === "string" && e.id.length > 0 && e.id.length <= 40
        ? e.id
        : `fx_${i}_${Date.now()}`;

    switch (e.type) {
      case "slow_motion": {
        const start = inClip(num(e.start, "start"), "start");
        const end = inClip(num(e.end, "end"), "end");
        if (end - start < 0.3) fail("range must be at least 0.3s");
        const factor = num(e.factor, "factor");
        if (factor < 0.25 || factor > 0.9) fail("slow-motion factor must be 0.25–0.9");
        out.push({ id, type: "slow_motion", start, end, factor });
        break;
      }
      case "speed_up": {
        const start = inClip(num(e.start, "start"), "start");
        const end = inClip(num(e.end, "end"), "end");
        if (end - start < 0.3) fail("range must be at least 0.3s");
        const factor = num(e.factor, "factor");
        if (factor < 1.1 || factor > 4) fail("speed-up factor must be 1.1–4");
        out.push({ id, type: "speed_up", start, end, factor });
        break;
      }
      case "freeze_frame": {
        const start = inClip(num(e.start, "start"), "start");
        const holdSeconds = num(e.holdSeconds, "holdSeconds");
        if (holdSeconds < 0.2 || holdSeconds > 5) fail("hold must be 0.2–5s");
        out.push({ id, type: "freeze_frame", start, holdSeconds });
        break;
      }
      case "color_grade": {
        const start = inClip(num(e.start, "start"), "start");
        const end = inClip(num(e.end, "end"), "end");
        if (end <= start) fail("end must be after start");
        if (!COLOR_PRESETS.has(String(e.preset))) fail("unknown color preset");
        out.push({
          id,
          type: "color_grade",
          start,
          end,
          preset: e.preset as never,
        });
        break;
      }
      case "punch_in": {
        const start = inClip(num(e.start, "start"), "start");
        const end = inClip(num(e.end, "end"), "end");
        if (end <= start) fail("end must be after start");
        const factor = num(e.factor, "factor");
        if (factor < 1.1 || factor > 2) fail("punch-in factor must be 1.1–2");
        out.push({ id, type: "punch_in", start, end, factor });
        break;
      }
      case "flash": {
        const start = inClip(num(e.start, "start"), "start");
        out.push({ id, type: "flash", start });
        break;
      }
      case "speed_ramp": {
        if (out.some((x) => x.type === "speed_ramp")) {
          fail("only one speed ramp per clip");
        }
        if (!Array.isArray(e.keyframes)) fail("keyframes must be an array");
        const kfRaw = e.keyframes as unknown[];
        if (kfRaw.length < 2 || kfRaw.length > 8) {
          fail("speed ramp needs 2–8 keyframes");
        }
        const keyframes = kfRaw.map((k, ki) => {
          const kf = k as Record<string, unknown>;
          const t = inClip(num(kf.t, `keyframe ${ki + 1} time`), "keyframe time");
          const speed = num(kf.speed, `keyframe ${ki + 1} speed`);
          if (speed < 0.05 || speed > 4) {
            fail(`keyframe ${ki + 1} speed must be 0.05–4`);
          }
          return { t, speed: Math.round(speed * 100) / 100 };
        });
        keyframes.sort((a, b) => a.t - b.t);
        const smoothness = e.smoothness === undefined ? 1 : num(e.smoothness, "smoothness");
        if (smoothness < 0 || smoothness > 1) fail("smoothness must be 0–1");
        const interpolation = String(e.interpolation ?? "dup");
        if (!["dup", "blend", "optical_flow"].includes(interpolation)) {
          fail("interpolation must be dup, blend or optical_flow");
        }
        const muteBelowSpeed =
          e.muteBelowSpeed === undefined ? 0.25 : num(e.muteBelowSpeed, "muteBelowSpeed");
        if (muteBelowSpeed < 0 || muteBelowSpeed > 1) {
          fail("muteBelowSpeed must be 0–1");
        }
        out.push({
          id,
          type: "speed_ramp",
          keyframes,
          smoothness,
          interpolation: interpolation as "dup" | "blend" | "optical_flow",
          muteBelowSpeed,
        });
        break;
      }
      case "glow_trail": {
        if (++trailCount > 1) fail("only one glow trail per clip");
        if (!Array.isArray(e.keyframes)) fail("keyframes must be an array");
        const kfRaw = e.keyframes as unknown[];
        if (kfRaw.length < 2 || kfRaw.length > 10) {
          fail("glow trail needs 2–10 keyframes");
        }
        const keyframes = kfRaw.map((k, ki) => {
          const kf = k as Record<string, unknown>;
          const t = inClip(num(kf.t, `keyframe ${ki + 1} time`), "keyframe time");
          const x = num(kf.x, "x");
          const y = num(kf.y, "y");
          if (x < 0 || x > 1 || y < 0 || y > 1) {
            fail(`keyframe ${ki + 1} position must be normalized 0–1`);
          }
          return { t, x, y };
        });
        keyframes.sort((a, b) => a.t - b.t);
        if (keyframes[keyframes.length - 1]!.t - keyframes[0]!.t < 0.2) {
          fail("trail keyframes must span at least 0.2s");
        }
        let color: string | undefined;
        if (e.color !== undefined) {
          if (!/^[0-9a-fA-F]{6}$/.test(String(e.color))) {
            fail("color must be 6-digit hex without #");
          }
          color = String(e.color).toLowerCase();
        }
        let size: number | undefined;
        if (e.size !== undefined) {
          size = num(e.size, "size");
          if (size < 0.5 || size > 2) fail("size must be 0.5–2");
        }
        out.push({ id, type: "glow_trail", keyframes, color, size });
        break;
      }
      default:
        fail(`unknown effect type "${String(e.type)}"`);
    }
  }

  // A speed ramp owns the whole velocity curve — no other speed effects
  if (
    out.some((e) => e.type === "speed_ramp") &&
    out.some((e) => ["slow_motion", "speed_up", "freeze_frame"].includes(e.type))
  ) {
    throw new BadRequestException(
      "A speed ramp replaces slow motion / speed-up / freeze effects — remove them or the ramp",
    );
  }

  // Speed-changing effects must not overlap one another
  const speedRanges = out
    .filter((e) =>
      ["slow_motion", "speed_up", "freeze_frame"].includes(e.type),
    )
    .map((e) => ({
      start: (e as { start: number }).start,
      end: "end" in e ? (e as { end: number }).end : (e as { start: number }).start,
    }))
    .sort((a, b) => a.start - b.start);
  for (let i = 1; i < speedRanges.length; i++) {
    if (speedRanges[i]!.start < speedRanges[i - 1]!.end - 0.001) {
      throw new BadRequestException(
        "Speed effects (slow motion, speed-up, freeze) must not overlap each other",
      );
    }
  }

  return out;
}
