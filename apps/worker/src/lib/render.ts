import { spawn } from "child_process";
import { FFMPEG } from "../env";
import { track } from "./children";
import type { PlanAudio, RangeEffect } from "@clipforge/shared-types";
import { buildTimeMap, type TimeMap } from "./time-map";
import {
  buildGatedEffects,
  buildGlowTrail,
  buildSpeedChain,
  remapGatedEffects,
  remapTrail,
} from "./effects";

/**
 * FFmpeg render engine. Builds one filtergraph per clip:
 * trim → speed chain (slow motion / speed-up / freeze) →
 * (blurred-background fill | pad) → gated effects (color grade,
 * punch-in, flash) → optional slow zoom → glow trail → burned captions
 * → fades → optional watermark, with loudness-normalized audio.
 */

export interface RenderSpec {
  inputPath: string;
  outputPath: string;
  sourceStart: number;
  sourceEnd: number;
  width: number;
  height: number;
  blurBackground: boolean;
  /** Scale to cover + center-crop — fills the frame, no bars at all */
  fillFrame?: boolean;
  zoom: boolean;
  assPath?: string; // burned captions when present
  hasAudio: boolean;
  watermarkText?: string;
  fps?: number;
  /** Advanced range effects; times relative to the trimmed clip */
  rangeEffects?: RangeEffect[];
  /** Glow sprite PNG (required when a glow_trail effect is present) */
  glowSpritePath?: string;
  /** Voice/audio controls (volume, pitch, EQ, effects) from the plan */
  audio?: Partial<PlanAudio>;
}

/**
 * Builds the voice-control filter chain applied before fades/loudnorm:
 * gain → pitch shift (duration-preserving) → denoise → voice clarity →
 * bass/treble shelves → character effect.
 */
export function buildAudioFxChain(audio: Partial<PlanAudio> | undefined): string {
  if (!audio) return "";
  const parts: string[] = [];

  const vol = audio.originalVolume;
  if (vol !== undefined && Math.abs(vol - 1) > 0.001) {
    parts.push(`volume=${Math.max(0, Math.min(3, vol)).toFixed(2)}`);
  }

  const semis = audio.pitchSemitones ?? 0;
  if (Math.abs(semis) >= 0.5) {
    // asetrate shifts pitch AND speed; atempo undoes the speed change.
    const factor = Math.pow(2, Math.max(-12, Math.min(12, semis)) / 12);
    parts.push(
      `asetrate=48000*${factor.toFixed(5)}`,
      `aresample=48000`,
      `atempo=${(1 / factor).toFixed(5)}`,
    );
  }

  if (audio.noiseReduction) parts.push("afftdn=nf=-25");
  if (audio.voiceEnhance) {
    parts.push(
      "highpass=f=80",
      "equalizer=f=3000:t=q:w=1:g=3",
      "acompressor=threshold=-18dB:ratio=3:attack=10:release=120",
    );
  }

  const bass = audio.bassGain ?? 0;
  if (Math.abs(bass) >= 0.5) {
    parts.push(`bass=g=${Math.max(-10, Math.min(10, bass)).toFixed(1)}`);
  }
  const treble = audio.trebleGain ?? 0;
  if (Math.abs(treble) >= 0.5) {
    parts.push(`treble=g=${Math.max(-10, Math.min(10, treble)).toFixed(1)}`);
  }

  switch (audio.voiceEffect) {
    case "telephone":
      parts.push("highpass=f=300", "lowpass=f=3400");
      break;
    case "echo":
      parts.push("aecho=0.8:0.7:60|180:0.4|0.2");
      break;
    case "robot":
      parts.push(
        "afftfilt=real='hypot(re,im)*sin(0)':imag='hypot(re,im)*cos(0)':win_size=512:overlap=0.75",
      );
      break;
  }
  return parts.length > 0 ? parts.join(",") + "," : "";
}

export function clipDuration(spec: Pick<RenderSpec, "sourceStart" | "sourceEnd">): number {
  return Math.max(0.5, spec.sourceEnd - spec.sourceStart);
}

export function specTimeMap(spec: RenderSpec): TimeMap {
  return buildTimeMap(spec.rangeEffects, clipDuration(spec));
}

/** Final output duration after speed effects (what QC should expect). */
export function renderOutputDuration(spec: RenderSpec): number {
  return specTimeMap(spec).outputDuration;
}

/**
 * Escapes a Windows/POSIX path for use inside an ffmpeg filter option:
 * backslashes → forward slashes, then ':' and quotes escaped.
 */
export function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

export function buildFilterGraph(spec: RenderSpec): string {
  const { width: w, height: h } = spec;
  const fps = spec.fps ?? 30;
  const chains: string[] = [];

  const map = specTimeMap(spec);
  const outDur = map.outputDuration;

  // ── Speed chain (slow motion / speed-up / freeze) ──────
  let vIn = "0:v";
  let aIn = "0:a";
  if (map.hasSpeedChanges) {
    const speed = buildSpeedChain(map, spec.hasAudio);
    chains.push(...speed.chains);
    vIn = speed.vOut;
    if (speed.aOut) aIn = speed.aOut;
  }

  // ── Layout ─────────────────────────────────────────────
  if (spec.fillFrame) {
    // Cover the whole frame: crop the source's excess width/height
    chains.push(
      `[${vIn}]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}[vbase]`,
    );
  } else if (spec.blurBackground) {
    // Blur at quarter resolution and upscale — visually identical for a
    // defocused background, ~16x cheaper than blurring at full size
    const qw = Math.round(w / 4 / 2) * 2;
    const qh = Math.round(h / 4 / 2) * 2;
    chains.push(
      `[${vIn}]split=2[v0][v1]`,
      `[v0]scale=${qw}:${qh}:force_original_aspect_ratio=increase,crop=${qw}:${qh},boxblur=luma_radius=7:luma_power=2,eq=brightness=-0.06,scale=${w}:${h}[bg]`,
      `[v1]scale=${w}:${h}:force_original_aspect_ratio=decrease[fg]`,
      `[bg][fg]overlay=(W-w)/2:(H-h)/2[vbase]`,
    );
  } else {
    chains.push(
      `[${vIn}]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black[vbase]`,
    );
  }
  let label = "vbase";

  // ── Gated effects (ranges remapped to output time) ─────
  const gated = remapGatedEffects(spec.rangeEffects, map);
  if (gated.length > 0) {
    const fx = buildGatedEffects(gated, label, w, h);
    chains.push(...fx.chains);
    label = fx.out;
  }

  if (spec.zoom) {
    // Gentle continuous push-in, capped at 8%. Implemented as per-frame
    // scale + centered crop — an order of magnitude cheaper than zoompan.
    const zExpr = `(1+0.08*min(t/${Math.max(outDur, 0.1).toFixed(3)},1))`;
    chains.push(
      `[${label}]scale=w='trunc(iw*${zExpr}/2)*2':h='trunc(ih*${zExpr}/2)*2':eval=frame,crop=${w}:${h}[vzoom]`,
    );
    label = "vzoom";
  }

  // ── Glow trail (sprite is input #1) ────────────────────
  const trail = (spec.rangeEffects ?? []).find((e) => e.type === "glow_trail");
  if (trail && trail.type === "glow_trail" && spec.glowSpritePath) {
    const t = buildGlowTrail(remapTrail(trail, map), label, 1, w, h, outDur);
    chains.push(...t.chains);
    label = t.out;
  }

  if (spec.assPath) {
    chains.push(
      `[${label}]subtitles=filename='${escapeFilterPath(spec.assPath)}'[vsub]`,
    );
    label = "vsub";
  }

  const fadeOutStart = Math.max(0, outDur - 0.45).toFixed(2);
  let tail = `[${label}]fade=t=in:st=0:d=0.4,fade=t=out:st=${fadeOutStart}:d=0.45`;
  if (spec.watermarkText) {
    const size = Math.max(20, Math.round(h * 0.02));
    const pad = Math.round(h * 0.025);
    tail += `,drawtext=text='${spec.watermarkText.replace(/[':\\]/g, "")}':font='Arial':fontcolor=white:alpha=0.55:fontsize=${size}:x=w-tw-${pad}:y=${pad}`;
  }
  chains.push(`${tail}[vout]`);

  if (spec.hasAudio) {
    const aFadeOut = Math.max(0, outDur - 0.4).toFixed(2);
    // Fixed rate first: the pitch shifter's asetrate math assumes 48 kHz
    const fx = buildAudioFxChain(spec.audio);
    const fadeIn = spec.audio?.fadeIn === false ? "" : "afade=t=in:st=0:d=0.25,";
    const fadeOut =
      spec.audio?.fadeOut === false ? "" : `afade=t=out:st=${aFadeOut}:d=0.4,`;
    const norm =
      spec.audio?.normalize === false ? "" : ",loudnorm=I=-16:TP=-1.5:LRA=11";
    chains.push(
      `[${aIn}]aformat=sample_rates=48000:channel_layouts=stereo,${fx}${fadeIn}${fadeOut}anull${norm}[aout]`,
    );
  }

  return chains.join(";");
}

export function buildRenderArgs(spec: RenderSpec): string[] {
  const dur = clipDuration(spec);
  const args = [
    "-hide_banner",
    "-loglevel", "error",
    "-nostats",
    "-progress", "pipe:1",
    // -ss AND -t before -i: both bound the INPUT read window. Placed after
    // -i, -t caps the OUTPUT instead and truncates the extra time added by
    // slow motion / freeze effects.
    "-ss", spec.sourceStart.toFixed(3),
    "-t", dur.toFixed(3),
    "-i", spec.inputPath,
  ];
  const hasTrail = (spec.rangeEffects ?? []).some((e) => e.type === "glow_trail");
  if (hasTrail && spec.glowSpritePath) {
    args.push("-i", spec.glowSpritePath);
  }
  args.push(
    "-filter_complex", buildFilterGraph(spec),
    "-map", "[vout]",
  );
  if (spec.hasAudio) {
    args.push("-map", "[aout]", "-c:a", "aac", "-b:a", "192k");
  } else {
    args.push("-an");
  }
  args.push(
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-r", String(spec.fps ?? 30),
    "-movflags", "+faststart",
    "-y",
    spec.outputPath,
  );
  return args;
}

export async function runRender(
  spec: RenderSpec,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  const dur = renderOutputDuration(spec);
  const args = buildRenderArgs(spec);
  await new Promise<void>((resolve, reject) => {
    const child = track(spawn(FFMPEG, args, { windowsHide: true }));
    let stderr = "";
    let stdoutBuf = "";
    child.stdout.on("data", (d: Buffer) => {
      stdoutBuf += d.toString();
      let idx: number;
      while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        const us = line.match(/^out_time_us=(\d+)/);
        if (us?.[1] && onProgress) {
          onProgress(Math.min(1, Number(us[1]) / 1_000_000 / dur));
        }
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 500_000) stderr = stderr.slice(-250_000);
    });
    child.on("error", (err) =>
      reject(new Error(`Failed to start ffmpeg: ${err.message}`)),
    );
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg render exited ${code}: ${stderr.slice(-1200)}`));
    });
  });
}
