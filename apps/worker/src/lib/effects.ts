import { spawn } from "child_process";
import { FFMPEG } from "../env";
import type {
  ColorPreset,
  GlowTrailEffect,
  RangeEffect,
  TrailKeyframe,
} from "@clipforge/shared-types";
import type { SpeedSegment, TimeMap } from "./time-map";

/**
 * Advanced range-effect rendering. Everything here emits FFmpeg
 * filtergraph fragments consumed by lib/render.ts:
 *  - speed chain: trim/setpts/atempo segments concatenated (slow motion,
 *    speed-up, freeze frame)
 *  - gated effects: color grades, punch-in zoom, impact flash, enabled
 *    only inside their (output-time) range
 *  - glow trail: a comet of glowing sprites following keyframed positions
 */

// ── Speed chain ───────────────────────────────────────────

export function buildSpeedChain(
  map: TimeMap,
  hasAudio: boolean,
  inLabelV = "0:v",
  inLabelA = "0:a",
): { chains: string[]; vOut: string; aOut: string | null } {
  const chains: string[] = [];
  const vParts: string[] = [];
  const aParts: string[] = [];

  if (hasAudio) {
    // Uniform audio format so freeze silence can be concatenated
    chains.push(`[${inLabelA}]aformat=sample_rates=48000:channel_layouts=stereo[aun]`);
  }

  map.segments.forEach((s, i) => {
    const v = `sv${i}`;
    if (s.speed === 0) {
      const hold = (s.holdSeconds ?? 1).toFixed(3);
      chains.push(
        `[${inLabelV}]trim=start=${s.srcStart.toFixed(3)}:end=${(s.srcStart + 0.05).toFixed(3)},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${hold}[${v}]`,
      );
      if (hasAudio) {
        chains.push(
          `anullsrc=r=48000:cl=stereo,atrim=duration=${hold}[sa${i}]`,
        );
      }
    } else {
      // Slowed ramp segments can synthesize frames: blend (cheap motion
      // blur) or mci (real optical flow — slow but ultra-smooth)
      const synth =
        s.interpolate === "mci"
          ? ",minterpolate=fps=30:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1"
          : s.interpolate === "blend"
            ? ",minterpolate=fps=30:mi_mode=blend"
            : "";
      chains.push(
        `[${inLabelV}]trim=start=${s.srcStart.toFixed(3)}:end=${s.srcEnd.toFixed(3)},setpts=(PTS-STARTPTS)/${s.speed}${synth}[${v}]`,
      );
      if (hasAudio) {
        const mute = s.mute ? ",volume=0" : "";
        chains.push(
          `[aun]atrim=start=${s.srcStart.toFixed(3)}:end=${s.srcEnd.toFixed(3)},asetpts=PTS-STARTPTS,${atempoChain(s.speed)}${mute}[sa${i}]`,
        );
      }
    }
    vParts.push(`[${v}]`);
    if (hasAudio) aParts.push(`[sa${i}]`);
  });

  // aun is consumed once per non-freeze segment — split it when reused
  if (hasAudio) {
    const audioUses = map.segments.filter((s) => s.speed !== 0).length;
    if (audioUses > 1) {
      const splitLabels = Array.from({ length: audioUses }, (_, i) => `[aun${i}]`).join("");
      chains[0] = `[${inLabelA}]aformat=sample_rates=48000:channel_layouts=stereo,asplit=${audioUses}${splitLabels}`;
      let use = 0;
      for (let i = 0; i < chains.length; i++) {
        if (chains[i]!.startsWith("[aun]atrim")) {
          chains[i] = chains[i]!.replace("[aun]", `[aun${use}]`);
          use++;
        }
      }
    }
  }

  const n = map.segments.length;
  if (hasAudio) {
    chains.push(
      `${interleave(vParts, aParts)}concat=n=${n}:v=1:a=1[vspeed][aspeed]`,
    );
    return { chains, vOut: "vspeed", aOut: "aspeed" };
  }
  chains.push(`${vParts.join("")}concat=n=${n}:v=1:a=0[vspeed]`);
  return { chains, vOut: "vspeed", aOut: null };
}

/** atempo only accepts 0.5–2 per instance — chain for wider factors. */
export function atempoChain(speed: number): string {
  const parts: string[] = [];
  let remaining = speed;
  while (remaining < 0.5) {
    parts.push("atempo=0.5");
    remaining /= 0.5;
  }
  while (remaining > 2) {
    parts.push("atempo=2.0");
    remaining /= 2;
  }
  parts.push(`atempo=${remaining.toFixed(4)}`);
  return parts.join(",");
}

function interleave(v: string[], a: string[]): string {
  let out = "";
  for (let i = 0; i < v.length; i++) out += v[i]! + (a[i] ?? "");
  return out;
}

// ── Gated effects (color, flash, punch-in) ────────────────
// Only timeline-capable filters (eq, hue) are used so `enable=` works.

const COLOR_PRESETS: Record<ColorPreset, string> = {
  cinematic: "eq=contrast=1.12:saturation=1.18:brightness=0.015:gamma_b=0.96:gamma_r=1.03",
  warm: "eq=saturation=1.12:gamma_r=1.08:gamma_b=0.92",
  cool: "eq=saturation=1.08:gamma_b=1.09:gamma_r=0.93",
  black_white: "hue=s=0",
  vivid: "eq=saturation=1.5:contrast=1.1",
};

/**
 * Appends gated effect filters onto a video label. Ranges are already
 * remapped to output time by the caller.
 */
export function buildGatedEffects(
  effects: Array<
    | { type: "color_grade"; start: number; end: number; preset: ColorPreset }
    | { type: "flash"; start: number }
    | { type: "punch_in"; start: number; end: number; factor: number }
  >,
  inLabel: string,
  width: number,
  height: number,
): { chains: string[]; out: string } {
  const chains: string[] = [];
  let label = inLabel;
  let idx = 0;

  for (const e of effects) {
    const next = `fx${idx++}`;
    if (e.type === "color_grade") {
      const filter = COLOR_PRESETS[e.preset] ?? COLOR_PRESETS.cinematic;
      chains.push(
        `[${label}]${filter}:enable='between(t,${e.start.toFixed(3)},${e.end.toFixed(3)})'[${next}]`,
      );
    } else if (e.type === "flash") {
      const t0 = e.start.toFixed(3);
      const t1 = (e.start + 0.16).toFixed(3);
      chains.push(
        `[${label}]eq=brightness=0.55:enable='between(t,${t0},${t1})'[${next}]`,
      );
    } else {
      const z = Math.max(1.1, Math.min(2, e.factor));
      chains.push(
        `[${label}]split=2[pi${idx}a][pi${idx}b]`,
        `[pi${idx}b]crop=w=iw/${z}:h=ih/${z},scale=${width}:${height}[pi${idx}z]`,
        `[pi${idx}a][pi${idx}z]overlay=0:0:enable='between(t,${e.start.toFixed(3)},${e.end.toFixed(3)})'[${next}]`,
      );
    }
    label = next;
  }
  return { chains, out: label };
}

// ── Glow trail ────────────────────────────────────────────

/** Renders the reusable radial glow sprite with lavfi (no assets needed). */
export async function createGlowSprite(
  outputPath: string,
  colorHex = "ffd25a",
): Promise<void> {
  const r = parseInt(colorHex.slice(0, 2), 16) || 255;
  const g = parseInt(colorHex.slice(2, 4), 16) || 210;
  const b = parseInt(colorHex.slice(4, 6), 16) || 90;
  const args = [
    "-y",
    "-nostdin",
    "-f", "lavfi",
    "-i",
    `color=c=black:s=96x96:d=1,format=rgba,geq=r='${r}':g='${g}':b='${b}':a='255*exp(-((X-48)*(X-48)+(Y-48)*(Y-48))/320)'`,
    "-frames:v", "1",
    outputPath,
  ];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(FFMPEG, args, { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`glow sprite generation failed: ${stderr.slice(-400)}`)),
    );
  });
}

/**
 * Piecewise-linear interpolation expression over keyframes for one axis.
 * Produces an ffmpeg expression in `t` (already shifted by the caller).
 */
export function buildPathExpression(
  keyframes: TrailKeyframe[],
  axis: "x" | "y",
  scale: number,
): string {
  const kfs = [...keyframes].sort((a, b) => a.t - b.t);
  const val = (k: TrailKeyframe) => (k[axis] * scale).toFixed(1);
  const first = kfs[0]!;
  const last = kfs[kfs.length - 1]!;
  let expr = val(last);
  for (let i = kfs.length - 2; i >= 0; i--) {
    const a = kfs[i]!;
    const b = kfs[i + 1]!;
    const dt = Math.max(0.001, b.t - a.t);
    const lerp = `${val(a)}+(${val(b)}-${val(a)})*(t-${a.t.toFixed(3)})/${dt.toFixed(3)}`;
    expr = `if(lt(t,${b.t.toFixed(3)}),${lerp},${expr})`;
  }
  return `if(lt(t,${first.t.toFixed(3)}),${val(first)},${expr})`;
}

const TRAIL_COPIES = 6;
const TRAIL_SPACING = 0.07; // seconds between trail ghosts

/**
 * Overlays a comet trail following the keyframed path: several
 * time-delayed, fading, shrinking copies of the glow sprite plus a
 * bright head.
 */
export function buildGlowTrail(
  effect: GlowTrailEffect & { keyframes: TrailKeyframe[] },
  inLabel: string,
  spriteInputIndex: number,
  width: number,
  height: number,
  totalDuration: number,
): { chains: string[]; out: string } {
  const kfs = [...effect.keyframes].sort((a, b) => a.t - b.t);
  const t0 = kfs[0]!.t;
  const t1 = kfs[kfs.length - 1]!.t;
  const size = Math.max(0.5, Math.min(2, effect.size ?? 1));

  const chains: string[] = [];
  const copies = TRAIL_COPIES;
  const labels = Array.from({ length: copies }, (_, i) => `[gs${i}]`).join("");
  chains.push(`[${spriteInputIndex}:v]format=rgba,split=${copies}${labels}`);

  let label = inLabel;
  // Draw oldest ghost first so the head lands on top
  for (let k = copies - 1; k >= 0; k--) {
    const delay = k * TRAIL_SPACING;
    const alpha = Math.pow(0.62, k) * (k === 0 ? 1 : 0.85);
    const px = Math.round((k === 0 ? 96 : 96 - k * 9) * size);
    const shifted = (expr: string) => expr.replace(/\bt\b/g, `(t-${delay.toFixed(3)})`);
    const xExpr = shifted(buildPathExpression(kfs, "x", width));
    const yExpr = shifted(buildPathExpression(kfs, "y", height));
    const g = `gt${k}`;
    // tpad clones the single sprite frame across the whole clip so the
    // overlay has frames at every timestamp (no -loop input needed)
    chains.push(
      `[gs${k}]scale=${px}:${px},colorchannelmixer=aa=${alpha.toFixed(3)},tpad=stop_mode=clone:stop_duration=${(totalDuration + 1).toFixed(2)}[${g}]`,
    );
    const next = `tr${k}`;
    chains.push(
      `[${label}][${g}]overlay=x='${xExpr}-${Math.round(px / 2)}':y='${yExpr}-${Math.round(px / 2)}':enable='between(t,${(t0 + delay).toFixed(3)},${(t1 + delay + 0.05).toFixed(3)})'[${next}]`,
    );
    label = next;
  }
  return { chains, out: label };
}

// ── Helpers for the render pipeline ───────────────────────

export function remapGatedEffects(
  effects: RangeEffect[] | undefined,
  map: TimeMap,
): Array<
  | { type: "color_grade"; start: number; end: number; preset: ColorPreset }
  | { type: "flash"; start: number }
  | { type: "punch_in"; start: number; end: number; factor: number }
> {
  const out: ReturnType<typeof remapGatedEffects> = [];
  for (const e of effects ?? []) {
    if (e.type === "color_grade") {
      out.push({
        type: "color_grade",
        start: map.toOutput(e.start),
        end: map.toOutput(e.end),
        preset: e.preset,
      });
    } else if (e.type === "flash") {
      out.push({ type: "flash", start: map.toOutput(e.start) });
    } else if (e.type === "punch_in") {
      out.push({
        type: "punch_in",
        start: map.toOutput(e.start),
        end: map.toOutput(e.end),
        factor: e.factor,
      });
    }
  }
  return out;
}

export function remapTrail(
  effect: GlowTrailEffect,
  map: TimeMap,
): GlowTrailEffect {
  return {
    ...effect,
    keyframes: effect.keyframes.map((k) => ({ ...k, t: map.toOutput(k.t) })),
  };
}
