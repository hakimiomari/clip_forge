import { spawn } from "child_process";
import { FFMPEG, FFPROBE } from "../env";
import { track } from "./children";

export interface ProbeResult {
  durationSeconds: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  hasAudio: boolean;
  formatName: string;
}

/** Runs a binary with args (no shell — args are never interpolated). */
function run(
  binary: string,
  args: string[],
  opts?: { timeoutMs?: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = track(spawn(binary, args, { windowsHide: true }));
    let stdout = "";
    let stderr = "";
    const timeout = opts?.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`${binary} timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs)
      : undefined;
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => {
      if (timeout) clearTimeout(timeout);
      reject(
        new Error(
          `Failed to start ${binary} — is it installed and on PATH? (${err.message})`,
        ),
      );
    });
    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      if (code === 0) resolve({ stdout, stderr });
      else
        reject(
          new Error(
            `${binary} exited with code ${code}: ${stderr.slice(-2000)}`,
          ),
        );
    });
  });
}

/** Filters the render pipeline needs that lean ffmpeg builds often omit. */
const REQUIRED_FILTERS: Array<{ name: string; feature: string }> = [
  { name: "subtitles", feature: "burned-in captions (needs libass)" },
  { name: "drawtext", feature: "watermark text (needs fontconfig/freetype)" },
];

/**
 * Warns at startup when the resolved ffmpeg can't do captions or
 * watermarks, so a missing library shows up before the first render
 * fails with an opaque "No such filter" error.
 */
export async function checkFfmpegCapabilities(): Promise<string[]> {
  const { stdout } = await run(FFMPEG, ["-hide_banner", "-filters"], {
    timeoutMs: 30_000,
  });
  const available = new Set(
    stdout
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/)[1])
      .filter((n): n is string => Boolean(n)),
  );
  const missing = REQUIRED_FILTERS.filter((f) => !available.has(f.name));
  for (const f of missing) {
    console.warn(
      `ffmpeg (${FFMPEG}) lacks the '${f.name}' filter — ${f.feature} will fail. ` +
        `Install a full build (e.g. \`brew install ffmpeg-full\`) or point FFMPEG_PATH at one.`,
    );
  }
  return missing.map((f) => f.name);
}

export async function probeVideo(filePath: string): Promise<ProbeResult> {
  const { stdout } = await run(
    FFPROBE,
    [
      "-v", "error",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      filePath,
    ],
    { timeoutMs: 60_000 },
  );
  const data = JSON.parse(stdout) as {
    format?: { duration?: string; format_name?: string };
    streams?: Array<{
      codec_type?: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
    }>;
  };
  const video = data.streams?.find((s) => s.codec_type === "video");
  const audio = data.streams?.find((s) => s.codec_type === "audio");
  const durationSeconds = Number(data.format?.duration ?? 0);
  if (!video || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("File does not contain a readable video stream");
  }
  let fps: number | null = null;
  const rate = video.avg_frame_rate;
  if (rate && rate !== "0/0") {
    const [num, den] = rate.split("/").map(Number);
    if (num && den) fps = Math.round((num / den) * 100) / 100;
  }
  return {
    durationSeconds,
    width: video.width ?? null,
    height: video.height ?? null,
    fps,
    hasAudio: Boolean(audio),
    formatName: data.format?.format_name ?? "unknown",
  };
}

/** Extracts a single frame as a JPEG thumbnail (max 640px wide). */
export async function generateThumbnail(
  inputPath: string,
  outputPath: string,
  atSeconds: number,
): Promise<void> {
  await run(
    FFMPEG,
    [
      "-y",
      "-ss", atSeconds.toFixed(2),
      "-i", inputPath,
      "-frames:v", "1",
      "-vf", "scale='min(640,iw)':-2",
      "-q:v", "3",
      outputPath,
    ],
    { timeoutMs: 120_000 },
  );
}

/**
 * Extracts compact mono AAC audio for transcription providers.
 * The source sample rate is kept: forcing -ar 16000 makes the native
 * AAC encoder pathologically slow (near-hang) on some content, and
 * transcription APIs resample internally anyway.
 */
export async function extractAudio(
  inputPath: string,
  outputPath: string,
): Promise<void> {
  await run(
    FFMPEG,
    [
      "-y",
      "-nostdin",
      "-i", inputPath,
      "-vn",
      "-ac", "1",
      "-c:a", "aac",
      "-b:a", "64k",
      outputPath,
    ],
    { timeoutMs: 30 * 60_000 },
  );
}
