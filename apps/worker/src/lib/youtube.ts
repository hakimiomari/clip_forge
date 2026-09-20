import { spawn } from "child_process";
import { readdir, readFile, stat } from "fs/promises";
import path from "path";
import { env, FFMPEG, YTDLP } from "../env";
import { track } from "./children";

/**
 * YouTube sources are never downloaded in full. Import reads metadata,
 * highlight analysis streams the media through ffmpeg from YouTube's
 * CDN, and rendering fetches only the seconds a clip needs.
 */

export interface YouTubeInfo {
  title: string | null;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  /** Best available caption track, or null when the video has none */
  captions: { lang: string; auto: boolean } | null;
}

export interface YouTubeTranscript {
  language: string;
  /** "youtube" for uploaded captions, "youtube-auto" for ASR captions */
  provider: "youtube" | "youtube-auto";
  segments: Array<{ startTime: number; endTime: number; text: string }>;
}

export interface YouTubeStreams {
  /** Audio-only stream (m4a) — small, used for silence/energy/transcription */
  audioUrl: string;
  /** Low-res video stream (≤360p) — enough for scene-change detection */
  videoUrl: string | null;
}

// Best MP4 up to 1080p with audio, merged by ffmpeg; progressive fallback
const CLIP_FORMAT =
  "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/bv*[height<=1080]+ba/b";

/** Runs yt-dlp with args (no shell — args are never interpolated). */
function runYtDlp(
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = track(spawn(YTDLP, args, { windowsHide: true }));
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`YouTube request timed out after ${Math.round(timeoutMs / 60_000)} min`));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
    });
    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `Failed to start ${YTDLP} — is yt-dlp installed and on PATH? (${err.message})`,
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(friendlyError(stderr)));
    });
  });
}

/** Surfaces yt-dlp's own ERROR line (private video, geo-block…) to the user. */
function friendlyError(stderr: string): string {
  const line = stderr
    .split(/\r?\n/)
    .reverse()
    .find((l) => l.startsWith("ERROR:"));
  return line
    ? `YouTube: ${line.replace(/^ERROR:\s*(\[youtube\]\s*\S+:\s*)?/, "")}`
    : `yt-dlp failed: ${stderr.slice(-500)}`;
}

function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/** Common flags: never expand playlists, and point yt-dlp at our ffmpeg. */
function baseArgs(): string[] {
  const args = ["--no-playlist", "--no-warnings", "--socket-timeout", "30", "--retries", "3"];
  if (env.FFMPEG_PATH?.trim()) {
    args.push("--ffmpeg-location", path.dirname(FFMPEG));
  }
  return args;
}

export async function fetchYouTubeInfo(videoId: string): Promise<YouTubeInfo> {
  const { stdout } = await runYtDlp(
    [...baseArgs(), "--dump-single-json", "--skip-download", "--", watchUrl(videoId)],
    2 * 60_000,
  );
  const info = JSON.parse(stdout) as {
    title?: string;
    thumbnail?: string;
    duration?: number;
    width?: number;
    height?: number;
    fps?: number;
    subtitles?: Record<string, unknown>;
    automatic_captions?: Record<string, unknown>;
  };
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    title: info.title ?? null,
    thumbnailUrl: info.thumbnail ?? null,
    durationSeconds: num(info.duration),
    width: num(info.width),
    height: num(info.height),
    fps: num(info.fps),
    captions: pickCaptionTrack(
      Object.keys(info.subtitles ?? {}),
      Object.keys(info.automatic_captions ?? {}),
    ),
  };
}

/**
 * Uploaded captions beat auto-generated ones; English beats other
 * languages; for ASR tracks the "<lang>-orig" key is the spoken language
 * (everything else is a machine translation of it).
 */
export function pickCaptionTrack(
  manual: string[],
  auto: string[],
): YouTubeInfo["captions"] {
  const isEnglish = (l: string) => l === "en" || l.startsWith("en-");
  const notLiveChat = (l: string) => l !== "live_chat";
  const manualLangs = manual.filter(notLiveChat);
  const manualPick = manualLangs.find(isEnglish) ?? manualLangs[0];
  if (manualPick) return { lang: manualPick, auto: false };
  const autoPick =
    auto.find((l) => l === "en-orig") ??
    auto.find((l) => l.endsWith("-orig")) ??
    auto.find(isEnglish) ??
    auto[0];
  return autoPick ? { lang: autoPick, auto: true } : null;
}

/**
 * Fetches one caption track (YouTube's json3 format) into `workDir` and
 * turns it into transcript segments. No media is downloaded.
 */
export async function fetchYouTubeTranscript(
  videoId: string,
  track: NonNullable<YouTubeInfo["captions"]>,
  workDir: string,
): Promise<YouTubeTranscript> {
  await runYtDlp(
    [
      ...baseArgs(),
      "--skip-download",
      track.auto ? "--write-auto-subs" : "--write-subs",
      "--sub-langs", track.lang,
      "--sub-format", "json3",
      "-o", path.join(workDir, "captions"),
      "--", watchUrl(videoId),
    ],
    2 * 60_000,
  );
  const file = (await readdir(workDir)).find(
    (f) => f.startsWith("captions.") && f.endsWith(".json3"),
  );
  if (!file) throw new Error("YouTube: caption track could not be fetched");
  const raw = await readFile(path.join(workDir, file), "utf8");
  return {
    language: track.lang.replace(/-orig$/, ""),
    provider: track.auto ? "youtube-auto" : "youtube",
    segments: parseJson3Captions(raw),
  };
}

/** Parses YouTube's json3 caption events into timed text segments. */
export function parseJson3Captions(
  raw: string,
): YouTubeTranscript["segments"] {
  const data = JSON.parse(raw) as {
    events?: Array<{
      tStartMs?: number;
      dDurationMs?: number;
      aAppend?: number;
      segs?: Array<{ utf8?: string }>;
    }>;
  };
  const segments: YouTubeTranscript["segments"] = [];
  for (const ev of data.events ?? []) {
    // aAppend events are line-break markers for the live-caption window
    if (!ev.segs || ev.aAppend || typeof ev.tStartMs !== "number") continue;
    const text = ev.segs
      .map((s) => s.utf8 ?? "")
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    // Add in integer ms, then divide once, so times stay clean (3.36 not 3.3600000000000003)
    const endMs = ev.tStartMs + Math.max(ev.dDurationMs ?? 0, 100);
    segments.push({ startTime: ev.tStartMs / 1000, endTime: endMs / 1000, text });
  }
  return segments;
}

/**
 * Resolves direct CDN URLs ffmpeg can read over HTTP. They expire after
 * a few hours, so resolve them inside the job that uses them.
 */
export async function resolveYouTubeStreams(videoId: string): Promise<YouTubeStreams> {
  const { stdout } = await runYtDlp(
    [
      ...baseArgs(),
      "-g",
      "-f", "ba[ext=m4a]/ba,bv*[height<=360][ext=mp4]/bv*[height<=360]/b[height<=360]",
      "--", watchUrl(videoId),
    ],
    2 * 60_000,
  );
  const urls = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const [audioUrl, videoUrl] = urls;
  if (!audioUrl) throw new Error("YouTube: no playable stream found for this video");
  return { audioUrl, videoUrl: videoUrl ?? null };
}

/**
 * Fetches just the [start, end] window of the video as an MP4 (yt-dlp
 * drives ffmpeg with byte-range requests; keyframes are forced at the
 * cut so the file starts exactly at `start`).
 */
export async function downloadYouTubeSection(
  videoId: string,
  start: number,
  end: number,
  outputPath: string,
): Promise<void> {
  const seconds = Math.max(1, end - start);
  await runYtDlp(
    [
      ...baseArgs(),
      "--no-progress",
      "--download-sections", `*${start.toFixed(3)}-${end.toFixed(3)}`,
      "--force-keyframes-at-cuts",
      "-f", CLIP_FORMAT,
      "--merge-output-format", "mp4",
      "-o", outputPath,
      "--", watchUrl(videoId),
    ],
    // Section fetches re-encode at the cut; allow ~4x realtime plus slack
    Math.max(5 * 60_000, seconds * 4_000),
  );
  const exists = await stat(outputPath).then(() => true, () => false);
  if (!exists) throw new Error("YouTube: section download produced no file");
}
