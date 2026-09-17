import { spawn } from "child_process";
import { FFMPEG, FFPROBE } from "../env";

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
    const child = spawn(binary, args, { windowsHide: true });
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
 * Extracts mono 16 kHz AAC audio — compact and sufficient for
 * transcription providers in Milestone 2.
 */
export async function extractAudio(
  inputPath: string,
  outputPath: string,
): Promise<void> {
  await run(
    FFMPEG,
    [
      "-y",
      "-i", inputPath,
      "-vn",
      "-ac", "1",
      "-ar", "16000",
      "-c:a", "aac",
      "-b:a", "64k",
      outputPath,
    ],
    { timeoutMs: 30 * 60_000 },
  );
}
