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

/**
 * One audio pass extracts BOTH silences and per-second RMS energy:
 * silencedetect logs to stderr while astats/ametadata prints to stdout,
 * so a single decode serves both (previously two full decodes).
 */
export async function analyzeAudio(
  filePath: string,
  opts?: { noiseDb?: number; minDuration?: number },
): Promise<{ silences: SilenceRange[]; energyPerSecond: number[] }> {
  const noise = opts?.noiseDb ?? -35;
  const minDur = opts?.minDuration ?? 0.4;
  const { stdout, stderr } = await runFfmpeg(
    [
      "-hide_banner",
      ...inputArgs(filePath),
      "-vn",
      "-af",
      `aformat=sample_rates=48000:channel_layouts=mono,` +
        `silencedetect=noise=${noise}dB:d=${minDur},` +
        `asetnsamples=n=48000,astats=metadata=1:reset=1,` +
        `ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=-`,
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

  const energyPerSecond: number[] = [];
  for (const match of stdout.matchAll(/RMS_level=(-?[\d.]+|-inf)/g)) {
    const raw = match[1];
    energyPerSecond.push(raw === "-inf" ? -91 : Number(raw));
  }
  return { silences, energyPerSecond };
}

/** Kept for compatibility/tests — delegates to the combined pass. */
export async function detectSilences(
  filePath: string,
  opts?: { noiseDb?: number; minDuration?: number },
): Promise<SilenceRange[]> {
  return (await analyzeAudio(filePath, opts)).silences;
}

export async function audioEnergyPerSecond(filePath: string): Promise<number[]> {
  return (await analyzeAudio(filePath)).energyPerSecond;
}

export async function detectSceneChanges(
  filePath: string,
  threshold = 0.35,
): Promise<number[]> {
  const { stderr } = await runFfmpeg(
    [
      "-hide_banner",
      ...inputArgs(filePath),
      "-an",
      // Sample at 6 fps and score at thumbnail size — cut points are the
      // same, decode-side filtering is far cheaper than full-rate scoring
      "-vf", `fps=6,scale=200:-2,select='gt(scene,${threshold})',showinfo`,
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

/** Scene detection cost scales with length; beyond this we rely on audio. */
const SCENE_DETECT_MAX_SECONDS = 45 * 60;

/**
 * Audio and video may come from different inputs (a local file for both,
 * or separate CDN streams for a YouTube source). `video: null` skips
 * scene detection, as do very long sources (audio signals carry the
 * heuristic on their own).
 */
export async function analyzeMedia(inputs: {
  audio: string;
  video: string | null;
  durationSeconds?: number;
}): Promise<MediaAnalysis> {
  const runScenes =
    inputs.video !== null &&
    (inputs.durationSeconds === undefined ||
      inputs.durationSeconds <= SCENE_DETECT_MAX_SECONDS);
  if (!runScenes && inputs.video) {
    console.warn(
      `Skipping scene detection for a ${Math.round((inputs.durationSeconds ?? 0) / 60)}min source (limit ${SCENE_DETECT_MAX_SECONDS / 60}min)`,
    );
  }
  const [audio, sceneChanges] = await Promise.all([
    analyzeAudio(inputs.audio),
    runScenes ? detectSceneChanges(inputs.video!) : Promise.resolve([]),
  ]);
  return { ...audio, sceneChanges };
}
