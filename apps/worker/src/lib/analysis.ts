import { spawn } from "child_process";
import { FFMPEG } from "../env";
import { track } from "./children";

/**
 * Signal analysis used by the heuristic highlight selector (and later the
 * scene agent). All of it is plain FFmpeg — no cloud calls.
 */

export interface SilenceRange {
  start: number;
  end: number;
}

export interface MediaAnalysis {
  /** Detected silence ranges (seconds) */
  silences: SilenceRange[];
  /** Timestamps of hard scene changes (seconds) */
  sceneChanges: number[];
  /** Mean RMS level (dB) per 1-second bin; -91 ≈ digital silence */
  energyPerSecond: number[];
}

function runFfmpeg(args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = track(spawn(FFMPEG, args, { windowsHide: true }));
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`ffmpeg analysis timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      // stderr can get large on long files; keep the tail
      if (stderr.length > 4_000_000) stderr = stderr.slice(-2_000_000);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`ffmpeg analysis exited ${code}: ${stderr.slice(-800)}`));
    });
  });
}

/**
 * Input flags for a local file or an https stream. Remote inputs get
 * reconnect handling so a dropped CDN connection doesn't abort analysis.
 */
function inputArgs(input: string): string[] {
  return /^https?:\/\//i.test(input)
    ? ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5", "-i", input]
    : ["-i", input];
}

export async function detectSilences(
  filePath: string,
  opts?: { noiseDb?: number; minDuration?: number },
): Promise<SilenceRange[]> {
  const noise = opts?.noiseDb ?? -35;
  const minDur = opts?.minDuration ?? 0.4;
  const { stderr } = await runFfmpeg(
    [
      "-hide_banner",
      ...inputArgs(filePath),
      "-vn",
      "-af", `silencedetect=noise=${noise}dB:d=${minDur}`,
      "-f", "null", "-",
    ],
    20 * 60_000,
  );
  const silences: SilenceRange[] = [];
  let currentStart: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const startMatch = line.match(/silence_start:\s*([\d.]+)/);
    if (startMatch?.[1]) {
      currentStart = Number(startMatch[1]);
      continue;
    }
    const endMatch = line.match(/silence_end:\s*([\d.]+)/);
    if (endMatch?.[1] && currentStart !== null) {
      silences.push({ start: currentStart, end: Number(endMatch[1]) });
      currentStart = null;
    }
  }
  return silences;
}

export async function detectSceneChanges(
  filePath: string,
  threshold = 0.3,
): Promise<number[]> {
  const { stderr } = await runFfmpeg(
    [
      "-hide_banner",
      ...inputArgs(filePath),
      "-an",
      // Downscale before scene scoring — much faster, same cut points
      "-vf", `scale=320:-2,select='gt(scene,${threshold})',showinfo`,
      "-f", "null", "-",
    ],
    30 * 60_000,
  );
  const times: number[] = [];
  for (const match of stderr.matchAll(/pts_time:([\d.]+)/g)) {
    const t = Number(match[1]);
    if (Number.isFinite(t)) times.push(t);
  }
  return times;
}

export async function audioEnergyPerSecond(filePath: string): Promise<number[]> {
  const { stdout } = await runFfmpeg(
    [
      "-hide_banner",
      ...inputArgs(filePath),
      "-vn",
      "-ac", "1",
      "-ar", "48000",
      "-af",
      "asetnsamples=n=48000,astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=-",
      "-f", "null", "-",
    ],
    20 * 60_000,
  );
  const energy: number[] = [];
  for (const match of stdout.matchAll(/RMS_level=(-?[\d.]+|-inf)/g)) {
    const raw = match[1];
    energy.push(raw === "-inf" ? -91 : Number(raw));
  }
  return energy;
}

/**
 * Audio and video may come from different inputs (a local file for both,
 * or separate CDN streams for a YouTube source). `video: null` skips
 * scene detection.
 */
export async function analyzeMedia(inputs: {
  audio: string;
  video: string | null;
}): Promise<MediaAnalysis> {
  const [silences, energyPerSecond, sceneChanges] = await Promise.all([
    detectSilences(inputs.audio),
    audioEnergyPerSecond(inputs.audio),
    inputs.video ? detectSceneChanges(inputs.video) : Promise.resolve([]),
  ]);
  return { silences, sceneChanges, energyPerSecond };
}
