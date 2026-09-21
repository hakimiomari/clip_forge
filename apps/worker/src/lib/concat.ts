import { spawn } from "child_process";
import { FFMPEG } from "../env";
import { track } from "./children";
import { pickThreadCount } from "./render";

/**
 * Stitches the parts of a multi-part clip into one intermediate file.
 *
 * Done as a separate pass rather than inside the render filtergraph so
 * that everything downstream — speed effects, captions, the banner,
 * background removal, QC — keeps working on a single continuous clip
 * and needs no notion of parts. Single-part clips skip this entirely.
 */

export interface ConcatPart {
  /** File to read this part from (the source, or a per-part download) */
  inputPath: string;
  /** Seconds into `inputPath` where the part begins */
  start: number;
  /** Length of the part in seconds */
  duration: number;
}

/**
 * Each part becomes its own input with `-ss`/`-t` *before* `-i`, so
 * ffmpeg seeks to it instead of decoding everything before it — the
 * difference between seconds and minutes on a long source.
 */
export function buildConcatArgs(
  parts: ConcatPart[],
  outputPath: string,
  options: {
    hasAudio: boolean;
    fps?: number;
    threads?: number;
    /**
     * Frame size every part is fitted to. Parts can differ — a YouTube
     * part that failed at 720p is re-fetched at 480p — and the concat
     * filter rejects mismatched sizes outright.
     */
    size?: { width: number; height: number };
  },
): string[] {
  if (parts.length < 2) {
    throw new Error("buildConcatArgs needs at least two parts");
  }
  const fps = options.fps ?? 30;
  const args = ["-hide_banner", "-loglevel", "error", "-nostats"];
  for (const part of parts) {
    args.push(
      "-ss", part.start.toFixed(3),
      "-t", part.duration.toFixed(3),
      "-i", part.inputPath,
    );
  }

  // Normalise before concat: the filter demands identical frame rate,
  // pixel aspect and (for audio) sample format across every input.
  const chains: string[] = [];
  const labels: string[] = [];
  const { size } = options;
  // Letterbox rather than stretch a part whose shape differs
  const fit = size
    ? `scale=${size.width}:${size.height}:force_original_aspect_ratio=decrease,` +
      `pad=${size.width}:${size.height}:(ow-iw)/2:(oh-ih)/2,`
    : "";
  parts.forEach((_, i) => {
    chains.push(`[${i}:v]${fit}fps=${fps},setsar=1,setpts=PTS-STARTPTS[cv${i}]`);
    labels.push(`[cv${i}]`);
    if (options.hasAudio) {
      chains.push(
        `[${i}:a]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[ca${i}]`,
      );
      labels.push(`[ca${i}]`);
    }
  });
  const audioStreams = options.hasAudio ? 1 : 0;
  chains.push(
    `${labels.join("")}concat=n=${parts.length}:v=1:a=${audioStreams}[cvout]${
      options.hasAudio ? "[caout]" : ""
    }`,
  );

  const threads = String(options.threads ?? pickThreadCount());
  args.push("-filter_complex", chains.join(";"), "-map", "[cvout]");
  if (options.hasAudio) {
    args.push("-map", "[caout]", "-c:a", "aac", "-b:a", "192k");
  } else {
    args.push("-an");
  }
  args.push(
    "-filter_complex_threads", threads,
    "-threads", threads,
    "-c:v", "libx264",
    "-preset", "veryfast",
    // Near-lossless: this is an intermediate the real render re-encodes
    "-crf", "18",
    "-pix_fmt", "yuv420p",
    "-r", String(fps),
    "-y",
    outputPath,
  );
  return args;
}

export async function concatParts(
  parts: ConcatPart[],
  outputPath: string,
  options: Parameters<typeof buildConcatArgs>[2],
): Promise<void> {
  const args = buildConcatArgs(parts, outputPath, options);
  await new Promise<void>((resolve, reject) => {
    const child = track(spawn(FFMPEG, args, { windowsHide: true }));
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    child.on("error", (err) =>
      reject(new Error(`Failed to start ffmpeg: ${err.message}`)),
    );
    child.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`ffmpeg could not join the clip parts (exit ${code}): ${stderr.slice(-800)}`),
        );
    });
  });
}
