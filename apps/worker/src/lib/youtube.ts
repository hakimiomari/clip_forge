import { spawn } from "child_process";
import { existsSync } from "fs";
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

// Best MP4 up to 720p with audio, merged by ffmpeg; progressive fallback.
// 720p (1280 wide) fully covers the 1080-wide vertical layout, and halves
// the memory of the keyframe re-encode — 1080p sports footage has made
// x264 fail malloc on busy machines.
const CLIP_FORMAT =
  "bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720][ext=mp4]/bv*[height<=720]+ba/b";
// Last-resort format when even 720p re-encoding fails (low memory)
const CLIP_FORMAT_FALLBACK =
  "b[height<=480][ext=mp4]/bv*[height<=480]+ba/b[height<=480]/wv*+ba/w";

/** Runs yt-dlp with args (no shell — args are never interpolated). */
function runYtDlp(
  args: string[],
  timeoutMs: number,
  onLine?: (line: string) => void,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = track(spawn(YTDLP, args, { windowsHide: true }));
    let stdout = "";
    let stderr = "";
    let pendingLine = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`YouTube request timed out after ${Math.round(timeoutMs / 60_000)} min`));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      const chunk = d.toString();
      stdout += chunk;
      if (!onLine) return;
      pendingLine += chunk;
      let idx: number;
      while ((idx = pendingLine.indexOf("\n")) >= 0) {
        onLine(pendingLine.slice(0, idx).trim());
        pendingLine = pendingLine.slice(idx + 1);
      }
    });
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
  if (/malloc .*failed|Cannot allocate memory|Out of memory/i.test(stderr)) {
    return (
      "YouTube: the machine ran out of memory while re-encoding the clip section. " +
      "Close other applications or retry — ClipForge also falls back to a lower resolution automatically."
    );
  }
  const line = stderr
    .split(/\r?\n/)
    .reverse()
    .find((l) => l.startsWith("ERROR:"));
  if (!line) return `yt-dlp failed: ${stderr.slice(-500)}`;
  let message = `YouTube: ${line.replace(/^ERROR:\s*(\[youtube\]\s*\S+:\s*)?/, "")}`;
  // A bare "ffmpeg exited with code N" hides the real cause — attach the
  // last ffmpeg error lines so failures are diagnosable.
  if (/ffmpeg exited with code/i.test(message)) {
    const detail = stderr
      .split(/\r?\n/)
      .filter((l) => /error|failed|invalid/i.test(l) && !l.startsWith("ERROR:"))
      .slice(-3)
      .join(" | ");
    if (detail) message += ` (${detail.slice(0, 300)})`;
  }
  return message;
}

function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/**
 * Where ffmpeg lives, for yt-dlp's benefit. It does its own lookup and
 * aborts a partial download if that misses — which happens whenever the
 * worker was started from a shell with a stale PATH. Telling it outright
 * removes that failure entirely.
 */
let ffmpegDirCache: string | null | undefined;
function ffmpegDirectory(): string | null {
  if (ffmpegDirCache !== undefined) return ffmpegDirCache;
  if (env.FFMPEG_PATH?.trim()) {
    ffmpegDirCache = path.dirname(FFMPEG);
    return ffmpegDirCache;
  }
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE").split(";").map((e) => e.toLowerCase())
      : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      if (existsSync(path.join(dir, `ffmpeg${ext}`))) {
        ffmpegDirCache = dir;
        return ffmpegDirCache;
      }
    }
  }
  ffmpegDirCache = null;
  return null;
}

/** Common flags: never expand playlists, and point yt-dlp at our ffmpeg. */
function baseArgs(): string[] {
  const args = ["--no-playlist", "--no-warnings", "--socket-timeout", "30", "--retries", "3"];
  const dir = ffmpegDirectory();
  if (dir) args.push("--ffmpeg-location", dir);
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
 * Pulls the media that analysis reads into `workDir`.
 *
 * Analysis used to point ffmpeg straight at the CDN URLs, but YouTube
 * throttles a single sequential read to roughly playback speed — a
 * 25-minute video took ~13 minutes just to read its audio, with the CPU
 * almost idle. yt-dlp fetches the same bytes in parallel chunks (~30s
 * for that audio), so downloading first and analysing locally is around
 * an order of magnitude faster. Both files live in the job's temp dir
 * and are deleted with it.
 */
export async function downloadAnalysisMedia(
  videoId: string,
  workDir: string,
  opts: {
    includeVideo: boolean;
    onProgress?: (stage: "audio" | "video", fraction: number) => void;
    /**
     * "lean" fetches the lowest-bitrate audio (~49k HE-AAC). Loudness and
     * silence read the same at any bitrate, and it is ~2.7x smaller — the
     * difference between minutes and seconds on a full-match video. Keep
     * "best" when the audio is also transcribed.
     */
    audioQuality?: "best" | "lean";
    /**
     * Per-track limit; the download is killed when it passes. Callers that
     * give up on a slow video must set this, or the abandoned download
     * keeps eating bandwidth the other videos need.
     */
    timeoutMs?: number;
  },
): Promise<{ audioPath: string; videoPath: string | null }> {
  const fetchTrack = async (
    stage: "audio" | "video",
    format: string,
    outPath: string,
  ): Promise<void> => {
    await runYtDlp(
      [
        ...baseArgs(),
        "--newline",
        // A machine-readable progress line we can turn into a percentage
        "--progress-template", "download:CFPROGRESS %(progress._percent_str)s",
        "-f", format,
        "-o", outPath,
        "--", watchUrl(videoId),
      ],
      opts.timeoutMs ?? 30 * 60_000,
      (line) => {
        const pct = line.match(/CFPROGRESS\s+([\d.]+)%/);
        if (pct?.[1]) opts.onProgress?.(stage, Number(pct[1]) / 100);
      },
    );
    const exists = await stat(outPath).then(() => true, () => false);
    if (!exists) throw new Error(`YouTube: could not download the ${stage} track`);
  };

  const audioPath = path.join(workDir, "analysis-audio.m4a");
  await fetchTrack(
    "audio",
    opts.audioQuality === "lean" ? "wa[ext=m4a]/wa" : "ba[ext=m4a]/ba",
    audioPath,
  );

  let videoPath: string | null = null;
  if (opts.includeVideo) {
    const target = path.join(workDir, "analysis-video.mp4");
    try {
      // Lowest usable resolution: scene detection scores thumbnails anyway
      await fetchTrack("video", "bv*[height<=360][ext=mp4]/bv*[height<=360]/b[height<=360]", target);
      videoPath = target;
    } catch (err) {
      // Scene cuts are a bonus signal; audio alone still produces highlights
      console.warn(`Analysis video unavailable, continuing audio-only: ${String(err).slice(0, 200)}`);
    }
  }
  return { audioPath, videoPath };
}

export interface HeatmapPoint {
  start: number;
  end: number;
  /** 0–1, how heavily this stretch is rewatched relative to the rest */
  value: number;
}

export interface VideoSignals {
  durationSeconds: number | null;
  /** YouTube's "Most replayed" graph — empty when the video has none */
  heatmap: HeatmapPoint[];
}

/**
 * Metadata only, no media: the replay heatmap tells us where viewers
 * rewind to, which is a better guide to a video's best moment than
 * anything we can measure — when YouTube provides one. Many videos
 * (most cricket uploads, in testing) have none.
 */
export async function fetchVideoSignals(videoId: string): Promise<VideoSignals> {
  const { stdout } = await runYtDlp(
    [...baseArgs(), "--skip-download", "--dump-json", "--", watchUrl(videoId)],
    2 * 60_000,
  );
  const info = JSON.parse(stdout) as {
    duration?: number;
    heatmap?: Array<{ start_time?: number; end_time?: number; value?: number }>;
  };
  return {
    durationSeconds: typeof info.duration === "number" ? info.duration : null,
    heatmap: (info.heatmap ?? [])
      .filter(
        (p) =>
          typeof p.start_time === "number" &&
          typeof p.end_time === "number" &&
          typeof p.value === "number",
      )
      .map((p) => ({ start: p.start_time!, end: p.end_time!, value: p.value! })),
  };
}

/**
 * Low-bitrate audio for just one window of a video — used to pin down
 * the exact moment inside a heatmap peak without fetching the rest.
 */
export async function downloadAudioSection(
  videoId: string,
  start: number,
  end: number,
  outputPath: string,
): Promise<void> {
  await runYtDlp(
    [
      ...baseArgs(),
      "--no-progress",
      "--download-sections", `*${start.toFixed(1)}-${end.toFixed(1)}`,
      "-f", "wa[ext=m4a]/wa",
      "-o", outputPath,
      "--", watchUrl(videoId),
    ],
    5 * 60_000,
  );
  const exists = await stat(outputPath).then(() => true, () => false);
  if (!exists) throw new Error("YouTube: audio section download produced no file");
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
  const attempt = (format: string) =>
    runYtDlp(
      [
        ...baseArgs(),
        "--no-progress",
        "--download-sections", `*${start.toFixed(3)}-${end.toFixed(3)}`,
        "--force-keyframes-at-cuts",
        "-f", format,
        "--merge-output-format", "mp4",
        "-o", outputPath,
        "--", watchUrl(videoId),
      ],
      // Section fetches re-encode at the cut; allow ~4x realtime plus slack
      Math.max(5 * 60_000, seconds * 4_000),
    );

  try {
    await attempt(CLIP_FORMAT);
  } catch (err) {
    // Transient CDN errors and encoder memory failures both deserve one
    // cheaper retry at lower resolution before giving up.
    console.warn(
      `YouTube section fetch failed at 720p, retrying at 480p: ${String(err).slice(0, 200)}`,
    );
    await attempt(CLIP_FORMAT_FALLBACK);
  }
  const exists = await stat(outputPath).then(() => true, () => false);
  if (!exists) throw new Error("YouTube: section download produced no file");
}
