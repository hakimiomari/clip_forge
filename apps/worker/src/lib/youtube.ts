import { spawn } from "child_process";
import { existsSync } from "fs";
import { readdir, readFile, stat } from "fs/promises";
import path from "path";
import { env, FFMPEG, YTDLP } from "../env";
import { killTree, track } from "./children";

/**
 * YouTube sources are never downloaded in full. Import reads metadata,
 * highlight analysis streams the media through ffmpeg from YouTube's
 * CDN, and rendering fetches only the seconds a clip needs.
 */

export interface YouTubeInfo {
  title: string | null;
  channel: string | null;
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

// Best H.264 MP4 up to 1080p with audio, merged by ffmpeg. 1080p is the
// original quality of nearly every upload, and the section is copied
// as-is (no re-encode), so the size costs bandwidth, not memory.
const CLIP_FORMAT =
  "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/bv*[height<=1080]+ba/b";
// Lower rungs for when YouTube keeps refusing the 1080p stream URL
const CLIP_FORMAT_720 =
  "bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720][ext=mp4]/bv*[height<=720]+ba/b";
const CLIP_FORMAT_FALLBACK =
  "b[height<=480][ext=mp4]/bv*[height<=480]+ba/b[height<=480]/wv*+ba/w";

/** Thrown when the caller aborted a download on purpose. */
export class DownloadCancelledError extends Error {
  constructor() {
    super("Download cancelled");
    this.name = "DownloadCancelledError";
  }
}

/** Runs yt-dlp with args (no shell — args are never interpolated). */
function runYtDlp(
  args: string[],
  timeoutMs: number,
  onLine?: (line: string) => void,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DownloadCancelledError());
      return;
    }
    // Own process group, so a timeout also takes down the ffmpeg that
    // yt-dlp spawns for section downloads and merges
    const child = track(spawn(YTDLP, args, { windowsHide: true, detached: true }));
    let stdout = "";
    let stderr = "";
    let pendingLine = "";
    signal?.addEventListener(
      "abort",
      () => {
        killTree(child);
        reject(new DownloadCancelledError());
      },
      { once: true },
    );
    const timeout = setTimeout(() => {
      killTree(child);
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
    channel?: string;
    uploader?: string;
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
    channel: info.channel ?? info.uploader ?? null,
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

export type FullDownloadQuality = "1080p" | "720p" | "480p" | "audio";

/**
 * The format for a complete video the user keeps: best H.264 at or below
 * the chosen height, which plays on every phone and editor, merged with
 * the best AAC audio. Other codecs only when YouTube has no H.264
 * rendition. "audio" is the AAC track alone.
 */
export function fullVideoFormat(quality: FullDownloadQuality): string {
  if (quality === "audio") return "ba[ext=m4a]/ba";
  const h = quality === "480p" ? 480 : quality === "720p" ? 720 : 1080;
  return (
    `bv*[height<=${h}][vcodec^=avc1]+ba[ext=m4a]/` +
    `bv*[height<=${h}][ext=mp4]+ba[ext=m4a]/` +
    `b[height<=${h}][ext=mp4]/bv*[height<=${h}]+ba/b`
  );
}

/**
 * Overall progress (0–1) from one yt-dlp progress line, or null for any
 * other line. The video track (vcodec set) is ~92% of the bytes and comes
 * first; the audio track (vcodec "none") is the rest.
 */
export function parseFullDownloadProgress(line: string, audioOnly = false): number | null {
  const m = line.match(/CFPROGRESS\s+(\S+)\s+([\d.]+)%/);
  if (!m) return null;
  const pct = Math.min(1, Number(m[2]) / 100);
  // An audio-only download is one track: its own percentage is the answer
  if (audioOnly) return pct;
  return m[1] === "none" ? 0.92 + pct * 0.08 : pct * 0.92;
}

/**
 * Downloads the whole video to `outPath` — MP4, or M4A for "audio".
 * yt-dlp fetches the video track and then the audio track, so progress
 * is weighted: the video is nearly all of the bytes.
 */
export async function downloadFullVideo(
  videoId: string,
  outPath: string,
  options: {
    timeoutMs: number;
    quality?: FullDownloadQuality;
    onProgress?: (fraction: number) => void;
    /** Aborting stops yt-dlp (and its ffmpeg) at once */
    signal?: AbortSignal;
  },
): Promise<void> {
  const quality = options.quality ?? "1080p";
  const audioOnly = quality === "audio";
  await runYtDlp(
    [
      ...baseArgs(),
      "--newline",
      "--progress-template",
      "download:CFPROGRESS %(info.vcodec)s %(progress._percent_str)s",
      "-f", fullVideoFormat(quality),
      // A single audio track needs no merging
      ...(audioOnly ? [] : ["--merge-output-format", "mp4"]),
      "-o", outPath,
      "--", watchUrl(videoId),
    ],
    options.timeoutMs,
    (line) => {
      const fraction = parseFullDownloadProgress(line, audioOnly);
      if (fraction !== null) options.onProgress?.(fraction);
    },
    options.signal,
  );
  const exists = await stat(outPath).then((s) => s.size > 0, () => false);
  if (!exists) throw new Error("YouTube: the full video download produced no file");
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
        // Stream-copied, not re-encoded: the file keeps the original
        // frames, and ffmpeg's edit list makes playback start on the exact
        // requested frame even though copying begins at the keyframe
        // before it. (Verified frame-for-frame against a re-encoded cut.)
        // A re-encode here was a whole quality generation lost, and the
        // memory hog behind past out-of-memory failures.
        "--download-sections", `*${start.toFixed(3)}-${end.toFixed(3)}`,
        // YouTube sometimes stops sending mid-stream without closing the
        // connection; ffmpeg would wait on it forever. Give up after 30s
        // of silence so the retry below gets a fresh URL instead.
        "--downloader-args", "ffmpeg_i:-rw_timeout 30000000",
        "-f", format,
        "--merge-output-format", "mp4",
        "-o", outputPath,
        "--", watchUrl(videoId),
      ],
      // A healthy copy takes well under a minute, so past 3 min it is
      // stuck, not slow
      Math.max(3 * 60_000, seconds * 4_000),
    );

  // YouTube refuses the odd stream URL (403) at random. Each attempt
  // asks for fresh signed URLs, so the same quality usually works a few
  // seconds later; only after that is a lower quality worth the loss.
  const plan: Array<{ format: string; label: string; pauseMs: number }> = [
    { format: CLIP_FORMAT, label: "1080p", pauseMs: 0 },
    { format: CLIP_FORMAT, label: "1080p", pauseMs: 3_000 },
    { format: CLIP_FORMAT_720, label: "720p", pauseMs: 5_000 },
    { format: CLIP_FORMAT_FALLBACK, label: "480p", pauseMs: 5_000 },
  ];
  for (const [i, step] of plan.entries()) {
    if (step.pauseMs > 0) await new Promise((r) => setTimeout(r, step.pauseMs));
    try {
      await attempt(step.format);
      break;
    } catch (err) {
      if (i === plan.length - 1) throw err;
      console.warn(
        `YouTube section fetch failed at ${step.label} (attempt ${i + 1}), ` +
          `retrying: ${String(err).slice(0, 200)}`,
      );
    }
  }
  const exists = await stat(outputPath).then(() => true, () => false);
  if (!exists) throw new Error("YouTube: section download produced no file");
}
