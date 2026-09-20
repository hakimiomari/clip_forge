import { spawn } from "child_process";
import { FFMPEG } from "../env";
import { track } from "./children";

/**
 * FFmpeg render engine. Builds one filtergraph per clip:
 * trim → (blurred-background fill | pad) → optional slow zoom →
 * burned captions → fades → optional watermark, with loudness-normalized
 * audio. Remotion-based animated templates layer on in a later milestone.
 */

export interface RenderSpec {
  inputPath: string;
  outputPath: string;
  sourceStart: number;
  sourceEnd: number;
  width: number;
  height: number;
  blurBackground: boolean;
  zoom: boolean;
  assPath?: string; // burned captions when present
  hasAudio: boolean;
  watermarkText?: string;
  fps?: number;
}

export function clipDuration(spec: Pick<RenderSpec, "sourceStart" | "sourceEnd">): number {
  return Math.max(0.5, spec.sourceEnd - spec.sourceStart);
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
  const dur = clipDuration(spec);
  const fps = spec.fps ?? 30;
  const chains: string[] = [];

  if (spec.blurBackground) {
    chains.push(
      `[0:v]split=2[v0][v1]`,
      `[v0]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},boxblur=luma_radius=28:luma_power=2,eq=brightness=-0.06[bg]`,
      `[v1]scale=${w}:${h}:force_original_aspect_ratio=decrease[fg]`,
      `[bg][fg]overlay=(W-w)/2:(H-h)/2[vbase]`,
    );
  } else {
    chains.push(
      `[0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black[vbase]`,
    );
  }

  let label = "vbase";
  if (spec.zoom) {
    // Gentle continuous push-in, capped at 8%
    const frames = Math.max(1, Math.round(dur * fps));
    const rate = (0.08 / frames).toFixed(8);
    chains.push(
      `[${label}]zoompan=z='min(zoom+${rate},1.08)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${w}x${h}:fps=${fps}[vzoom]`,
    );
    label = "vzoom";
  }

  if (spec.assPath) {
    chains.push(
      `[${label}]subtitles=filename='${escapeFilterPath(spec.assPath)}'[vsub]`,
    );
    label = "vsub";
  }

  const fadeOutStart = Math.max(0, dur - 0.45).toFixed(2);
  let tail = `[${label}]fade=t=in:st=0:d=0.4,fade=t=out:st=${fadeOutStart}:d=0.45`;
  if (spec.watermarkText) {
    const size = Math.max(20, Math.round(h * 0.02));
    const pad = Math.round(h * 0.025);
    tail += `,drawtext=text='${spec.watermarkText.replace(/[':\\]/g, "")}':font='Arial':fontcolor=white:alpha=0.55:fontsize=${size}:x=w-tw-${pad}:y=${pad}`;
  }
  chains.push(`${tail}[vout]`);

  if (spec.hasAudio) {
    const aFadeOut = Math.max(0, dur - 0.4).toFixed(2);
    chains.push(
      `[0:a]afade=t=in:st=0:d=0.25,afade=t=out:st=${aFadeOut}:d=0.4,loudnorm=I=-16:TP=-1.5:LRA=11[aout]`,
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
    "-ss", spec.sourceStart.toFixed(3),
    "-i", spec.inputPath,
    "-t", dur.toFixed(3),
    "-filter_complex", buildFilterGraph(spec),
    "-map", "[vout]",
  ];
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
  const dur = clipDuration(spec);
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
