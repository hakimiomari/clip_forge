import { spawn } from "child_process";
import { createWriteStream } from "fs";
import { writeFile } from "fs/promises";
import path from "path";
import { pipeline } from "stream/promises";
import type { Readable } from "stream";
import type { ResearchFormat, ResearchScene } from "@clipforge/shared-types";
import { FFMPEG } from "../../env";
import { track } from "../children";
import { buildAssDocument, type CaptionLine } from "../captions";
import { probeVideo } from "../ffmpeg";
import { pickThreadCount } from "../render";

/**
 * Builds one scene at a time, then joins them. Rendering each scene to
 * its own file keeps the ffmpeg graphs small and means one awkward
 * image can't take down the whole video.
 */

export const RESEARCH_RESOLUTIONS: Record<ResearchFormat, { width: number; height: number }> = {
  vertical: { width: 1080, height: 1920 },
  square: { width: 1080, height: 1080 },
  landscape: { width: 1920, height: 1080 },
};

const USER_AGENT = "ClipForge/0.1 (research video builder)";

function run(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = track(spawn(FFMPEG, args, { windowsHide: true }));
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`ffmpeg timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString().slice(-4000)));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`ffmpeg failed to start: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve()
        : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-400)}`));
    });
  });
}

/** Downloads a Commons file into the work dir. */
export async function fetchMedia(url: string, outPath: string): Promise<void> {
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(120_000),
    redirect: "follow",
  });
  if (!response.ok || !response.body) {
    throw new Error(`media download failed: HTTP ${response.status}`);
  }
  await pipeline(response.body as unknown as Readable, createWriteStream(outPath));
}

/** Whether a downloaded file carries a usable audio stream. */
async function hasAudioStream(filePath: string): Promise<boolean> {
  try {
    return (await probeVideo(filePath)).hasAudio;
  } catch {
    return false;
  }
}

/** Escapes a path for use inside an ffmpeg filter argument. */
function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

/**
 * One scene: the picture or clip filling the frame with a blurred copy
 * behind it, a slow push-in so a still doesn't sit dead on screen, and
 * the sentence burned in as a caption.
 */
export async function renderScene(options: {
  mediaPath: string | null;
  isVideo: boolean;
  text: string;
  seconds: number;
  audioPath: string | null;
  outPath: string;
  workDir: string;
  index: number;
  format: ResearchFormat;
}): Promise<void> {
  const { width, height } = RESEARCH_RESOLUTIONS[options.format];
  const fps = 30;
  const duration = Math.max(1.5, options.seconds);

  const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y"];
  if (options.mediaPath && !options.isVideo) {
    args.push("-loop", "1", "-framerate", String(fps), "-t", duration.toFixed(2), "-i", options.mediaPath);
  } else if (options.mediaPath) {
    // Loop a short clip so it fills the scene rather than freezing
    args.push("-stream_loop", "-1", "-t", duration.toFixed(2), "-i", options.mediaPath);
  } else {
    args.push("-f", "lavfi", "-t", duration.toFixed(2), "-i", `color=c=#0b0d12:s=${width}x${height}:r=${fps}`);
  }

  const hasNarration = Boolean(options.audioPath);
  let inputCount = 1; // the picture/clip/colour is input 0
  if (options.audioPath) {
    args.push("-i", options.audioPath);
    inputCount++;
  }

  // Every scene must end up with exactly one audio stream: the scenes are
  // joined with a stream copy, which needs identical layouts throughout.
  // A clip with no sound of its own therefore gets a silent track.
  const sourceHasAudio =
    !hasNarration && options.isVideo && options.mediaPath
      ? await hasAudioStream(options.mediaPath)
      : false;
  let silenceIndex = -1;
  if (!hasNarration && !sourceHasAudio) {
    silenceIndex = inputCount;
    // Declared here, with the other inputs: an -i after an output option
    // makes ffmpeg read that option as belonging to this input
    args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
    inputCount++;
  }

  // Caption as a burned ASS file — the same renderer the clips use, so
  // the look matches the rest of the app
  const lines: CaptionLine[] = [{ startTime: 0, endTime: duration, text: options.text }];
  const assPath = path.join(options.workDir, `scene-${options.index}.ass`);
  await writeFile(
    assPath,
    buildAssDocument(lines, {
      style: "bold_dynamic",
      position: options.format === "vertical" ? "bottom" : "bottom",
      width,
      height,
    }),
    "utf8",
  );

  // Slow push-in, ~6% over the scene; on a still this is what stops the
  // frame feeling like a slideshow
  const zoom = `(1+0.06*min(t/${duration.toFixed(2)},1))`;
  const qw = Math.round(width / 4 / 2) * 2;
  const qh = Math.round(height / 4 / 2) * 2;
  const graph = [
    `[0:v]fps=${fps},split=2[bg][fg]`,
    `[bg]scale=${qw}:${qh}:force_original_aspect_ratio=increase,crop=${qw}:${qh},boxblur=luma_radius=7:luma_power=2,eq=brightness=-0.10,scale=${width}:${height}[bgout]`,
    `[fg]scale=${width}:${height}:force_original_aspect_ratio=decrease[fgout]`,
    `[bgout][fgout]overlay=(W-w)/2:(H-h)/2[flat]`,
    `[flat]scale=w='trunc(iw*${zoom}/2)*2':h='trunc(ih*${zoom}/2)*2':eval=frame,crop=${width}:${height}[zoomed]`,
    `[zoomed]subtitles=filename='${escapeFilterPath(assPath)}'[vout]`,
  ].join(";");

  args.push("-filter_complex", graph, "-map", "[vout]");
  if (hasNarration) {
    args.push("-map", "1:a");
  } else if (sourceHasAudio) {
    // Keep the clip's own sound when there is no narration over it
    args.push("-map", "0:a");
  } else {
    args.push("-map", `${silenceIndex}:a`, "-shortest");
  }
  args.push(
    // Pinned rate and channel count: scenes whose audio came from
    // different sources must still match for the concat copy
    "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
    "-t", duration.toFixed(2),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-pix_fmt", "yuv420p", "-r", String(fps),
    "-threads", String(pickThreadCount()),
    options.outPath,
  );

  await run(args, 5 * 60_000);
}

/** Joins the finished scenes into the final video. */
export async function joinScenes(
  scenePaths: string[],
  outPath: string,
  workDir: string,
): Promise<void> {
  if (scenePaths.length === 0) throw new Error("no scenes were rendered");
  const listPath = path.join(workDir, "scenes.txt");
  await writeFile(
    listPath,
    scenePaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"),
    "utf8",
  );
  // Every scene was encoded with identical settings, so they can be
  // concatenated without a re-encode
  await run(
    ["-nostdin", "-hide_banner", "-loglevel", "error", "-y",
     "-f", "concat", "-safe", "0", "-i", listPath,
     "-c", "copy", "-movflags", "+faststart", outPath],
    5 * 60_000,
  );
}

/** A still from the middle of the video, for the library thumbnail. */
export async function grabThumbnail(
  videoPath: string,
  outPath: string,
  atSeconds: number,
): Promise<void> {
  await run(
    ["-nostdin", "-hide_banner", "-loglevel", "error", "-y",
     "-ss", Math.max(0, atSeconds).toFixed(2), "-i", videoPath,
     "-frames:v", "1", "-vf", "scale='min(720,iw)':-2", "-q:v", "3", outPath],
    60_000,
  );
}

export type { ResearchScene };
