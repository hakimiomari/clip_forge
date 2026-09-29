import { spawn } from "child_process";
import { GENERATED_RESOLUTIONS, type GeneratedFormat } from "@clipforge/shared-types";
import { FFMPEG } from "../../env";
import { track } from "../children";
import { probeVideo } from "../ffmpeg";
import { pickThreadCount } from "../render";

function run(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = track(spawn(FFMPEG, args, { windowsHide: true }));
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`ffmpeg timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 100_000) stderr = stderr.slice(-50_000);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to start ffmpeg: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve()
        : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-400)}`));
    });
  });
}

/**
 * One shot, fitted to the output frame with a blurred copy behind it,
 * fading in and out so the cuts between shots are soft. A picture gets
 * a slow push-in — that motion is what makes the free engine's output
 * feel like video. Video shots keep their own sound; anything silent
 * gets a silent track, since the shots are joined with a stream copy
 * that needs identical layouts.
 *
 * Returns the shot's length in seconds.
 */
export async function renderShot(options: {
  mediaPath: string;
  isVideo: boolean;
  seconds: number;
  format: GeneratedFormat;
  outPath: string;
}): Promise<number> {
  const { width, height } = GENERATED_RESOLUTIONS[options.format];
  const fps = 30;
  let duration = Math.max(1, options.seconds);
  let hasAudio = false;
  if (options.isVideo) {
    const probe = await probeVideo(options.mediaPath);
    hasAudio = probe.hasAudio;
    // Never run past what the engine actually made
    if (probe.durationSeconds > 0) duration = Math.min(duration, probe.durationSeconds);
  }

  const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y"];
  if (options.isVideo) {
    args.push("-i", options.mediaPath);
  } else {
    args.push("-loop", "1", "-framerate", String(fps), "-t", duration.toFixed(2), "-i", options.mediaPath);
  }
  if (!hasAudio) {
    args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
  }

  const qw = Math.round(width / 4 / 2) * 2;
  const qh = Math.round(height / 4 / 2) * 2;
  const fadeOut = Math.max(0, duration - 0.35).toFixed(2);
  // The free engine stamps its name along the bottom edge of every
  // picture (its no-logo flag is ignored now); the strip is cut off
  // before the picture is used
  const trim = options.isVideo ? "" : "crop=iw:trunc(ih*0.94/2)*2:0:0,";
  const chains = [
    `[0:v]${trim}fps=${fps},split=2[bg][fg]`,
    `[bg]scale=${qw}:${qh}:force_original_aspect_ratio=increase,crop=${qw}:${qh},boxblur=luma_radius=7:luma_power=2,eq=brightness=-0.10,scale=${width}:${height}[bgout]`,
    `[fg]scale=${width}:${height}:force_original_aspect_ratio=decrease[fgout]`,
    `[bgout][fgout]overlay=(W-w)/2:(H-h)/2[flat]`,
  ];
  let label = "flat";
  if (!options.isVideo) {
    // ~8% push-in over the shot
    const zoom = `(1+0.08*min(t/${duration.toFixed(2)},1))`;
    chains.push(
      `[flat]scale=w='trunc(iw*${zoom}/2)*2':h='trunc(ih*${zoom}/2)*2':eval=frame,crop=${width}:${height}[moving]`,
    );
    label = "moving";
  }
  chains.push(`[${label}]fade=t=in:st=0:d=0.3,fade=t=out:st=${fadeOut}:d=0.35[vout]`);

  args.push(
    "-filter_complex", chains.join(";"),
    "-map", "[vout]",
    "-map", hasAudio ? "0:a" : "1:a",
    "-af", `afade=t=in:st=0:d=0.3,afade=t=out:st=${fadeOut}:d=0.35`,
    "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2",
    "-t", duration.toFixed(2),
    "-c:v", "libx264", "-preset", "fast", "-crf", "17",
    "-pix_fmt", "yuv420p", "-r", String(fps),
    "-threads", String(pickThreadCount()),
    options.outPath,
  );
  await run(args, 5 * 60_000);
  return duration;
}
