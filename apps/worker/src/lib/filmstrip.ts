import { spawn } from "child_process";
import path from "path";
import { FFMPEG } from "../env";
import { track } from "./children";

/**
 * Timeline filmstrip: evenly spaced frames tiled into one sprite sheet
 * the editor draws behind the timeline track.
 *
 * Frames are grabbed with independent `-ss` seeks rather than decoding
 * the whole video — over HTTP (a YouTube CDN stream or presigned S3
 * object) each seek is a small range request, so a 3-hour source costs
 * seconds instead of a full decode.
 */

export interface FilmstripGeometry {
  count: number;
  columns: number;
  rows: number;
  frameWidth: number;
  frameHeight: number;
  /** Seconds between consecutive frames */
  interval: number;
}

export const FRAME_WIDTH = 160;
export const FRAME_HEIGHT = 90;
/** Parallel ffmpeg seeks — enough to hide network latency, not enough to thrash */
const SEEK_CONCURRENCY = 4;

/**
 * One frame per ~5s of source, bounded so short clips still get a
 * usable strip and long ones stay a reasonable sprite (120 frames at
 * 160×90 tiles to 1920×900).
 */
export function planFilmstrip(durationSeconds: number): FilmstripGeometry {
  const count = Math.max(24, Math.min(120, Math.round(durationSeconds / 5)));
  const columns = Math.min(count, 12);
  return {
    count,
    columns,
    rows: Math.ceil(count / columns),
    frameWidth: FRAME_WIDTH,
    frameHeight: FRAME_HEIGHT,
    interval: durationSeconds / count,
  };
}

/** Frame `i` is sampled from the middle of its slice, never at 0. */
export function frameTime(index: number, geometry: FilmstripGeometry): number {
  return (index + 0.5) * geometry.interval;
}

function runFfmpeg(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = track(spawn(FFMPEG, args, { windowsHide: true }));
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`ffmpeg filmstrip step timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-600)}`));
    });
  });
}

function inputArgs(input: string): string[] {
  return /^https?:\/\//i.test(input)
    ? ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5", "-i", input]
    : ["-i", input];
}

/**
 * Grabs one frame into a uniform cell so tiling lines up. Frames are
 * scaled to cover and centre-cropped rather than letterboxed: the strip
 * then reads as one continuous ribbon instead of thumbnails separated
 * by black bars (4:3 sources are the common case).
 */
async function grabFrame(
  input: string,
  atSeconds: number,
  outputPath: string,
): Promise<void> {
  await runFfmpeg(
    [
      "-y",
      "-nostdin",
      // -ss before -i = fast seek (keyframe accurate, which is fine here)
      "-ss", atSeconds.toFixed(3),
      ...inputArgs(input),
      "-frames:v", "1",
      "-vf",
      `scale=${FRAME_WIDTH}:${FRAME_HEIGHT}:force_original_aspect_ratio=increase,` +
        `crop=${FRAME_WIDTH}:${FRAME_HEIGHT}`,
      "-q:v", "4",
      outputPath,
    ],
    2 * 60_000,
  );
}

/**
 * Renders every frame and tiles them into `outputPath`. Frames that
 * fail (a bad seek near the end, a sparse stream) are left black rather
 * than failing the whole strip.
 */
export async function buildFilmstrip(options: {
  input: string;
  workDir: string;
  outputPath: string;
  geometry: FilmstripGeometry;
  onProgress?: (done: number, total: number) => void;
}): Promise<void> {
  const { input, workDir, outputPath, geometry, onProgress } = options;
  const framePath = (i: number) =>
    path.join(workDir, `frame-${String(i + 1).padStart(4, "0")}.jpg`);

  // A black placeholder guarantees every tile slot has a file, so one
  // failed seek can't shift the whole sprite by a cell.
  const blankPath = path.join(workDir, "blank.jpg");
  await runFfmpeg(
    [
      "-y", "-nostdin",
      "-f", "lavfi",
      "-i", `color=c=#0b0d12:s=${FRAME_WIDTH}x${FRAME_HEIGHT}`,
      "-frames:v", "1",
      blankPath,
    ],
    30_000,
  );

  let done = 0;
  let next = 0;
  const workers = Array.from(
    { length: Math.min(SEEK_CONCURRENCY, geometry.count) },
    async () => {
      for (let i = next++; i < geometry.count; i = next++) {
        try {
          await grabFrame(input, frameTime(i, geometry), framePath(i));
        } catch {
          await runFfmpeg(["-y", "-nostdin", "-i", blankPath, "-frames:v", "1", framePath(i)], 30_000);
        }
        onProgress?.(++done, geometry.count);
      }
    },
  );
  await Promise.all(workers);

  await runFfmpeg(
    [
      "-y",
      "-nostdin",
      "-i", path.join(workDir, "frame-%04d.jpg"),
      "-filter_complex", `tile=${geometry.columns}x${geometry.rows}`,
      "-frames:v", "1",
      "-q:v", "4",
      outputPath,
    ],
    5 * 60_000,
  );
}
