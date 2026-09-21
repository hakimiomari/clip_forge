import { spawn } from "child_process";
import { writeFile } from "fs/promises";
import path from "path";
import { FFMPEG } from "../../env";
import { track } from "../children";

/**
 * Normalises each downloaded moment to the output format, then joins
 * them. Every segment is encoded with identical settings so the join
 * itself is a stream copy — the expensive work happens once per moment,
 * not again over the whole compilation.
 */

export const COMPILATION_RESOLUTIONS: Record<
  string,
  { width: number; height: number }
> = {
  vertical: { width: 1080, height: 1920 },
  square: { width: 1080, height: 1080 },
  landscape: { width: 1920, height: 1080 },
};

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

/** drawtext is picky about quotes, colons and backslashes. */
export function escapeDrawText(value: string): string {
  return value
    .replace(/\\/g, "")
    .replace(/'/g, "")
    .replace(/:/g, " -")
    .replace(/[%{}]/g, "")
    .slice(0, 70);
}

/**
 * One moment, sized to the output format with a blurred fill behind it,
 * fading in and out so cuts between sources aren't jarring. When
 * `credit` is given it is drawn small along the bottom, which both
 * names the source on screen and matches what the description lists.
 */
export async function renderMoment(options: {
  inputPath: string;
  outPath: string;
  seconds: number;
  format: string;
  credit?: string | null;
}): Promise<void> {
  const { width, height } =
    COMPILATION_RESOLUTIONS[options.format] ?? COMPILATION_RESOLUTIONS.vertical!;
  const fps = 30;
  const duration = Math.max(1, options.seconds);
  const qw = Math.round(width / 4 / 2) * 2;
  const qh = Math.round(height / 4 / 2) * 2;

  const chains = [
    `[0:v]fps=${fps},split=2[bg][fg]`,
    `[bg]scale=${qw}:${qh}:force_original_aspect_ratio=increase,crop=${qw}:${qh},boxblur=luma_radius=7:luma_power=2,eq=brightness=-0.08,scale=${width}:${height}[bgout]`,
    `[fg]scale=${width}:${height}:force_original_aspect_ratio=decrease[fgout]`,
    `[bgout][fgout]overlay=(W-w)/2:(H-h)/2[flat]`,
  ];
  let label = "flat";
  if (options.credit) {
    const size = Math.max(14, Math.round(height * 0.014));
    chains.push(
      `[${label}]drawtext=text='${escapeDrawText(options.credit)}':fontcolor=white@0.75:fontsize=${size}:box=1:boxcolor=black@0.35:boxborderw=6:x=(w-tw)/2:y=h-th-${Math.round(height * 0.03)}[credited]`,
    );
    label = "credited";
  }
  // Short fades hide the hard cut between two different sources
  const fadeOut = Math.max(0, duration - 0.35).toFixed(2);
  chains.push(
    `[${label}]fade=t=in:st=0:d=0.3,fade=t=out:st=${fadeOut}:d=0.35[vout]`,
  );

  await run(
    [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
      "-i", options.inputPath,
      "-filter_complex", chains.join(";"),
      "-map", "[vout]",
      "-map", "0:a?",
      "-af", "afade=t=in:st=0:d=0.3,afade=t=out:st=" + fadeOut + ":d=0.35,loudnorm=I=-16:TP=-1.5:LRA=11",
      "-t", duration.toFixed(2),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-pix_fmt", "yuv420p", "-r", String(fps),
      "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2",
      options.outPath,
    ],
    6 * 60_000,
  );
}

/** Joins the rendered moments; identical settings mean no re-encode. */
export async function joinMoments(
  parts: string[],
  outPath: string,
  workDir: string,
): Promise<void> {
  if (parts.length === 0) throw new Error("no moments were rendered");
  const listPath = path.join(workDir, "moments.txt");
  await writeFile(
    listPath,
    parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"),
    "utf8",
  );
  await run(
    [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
      "-f", "concat", "-safe", "0", "-i", listPath,
      "-c", "copy", "-movflags", "+faststart", outPath,
    ],
    5 * 60_000,
  );
}
