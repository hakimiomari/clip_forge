import { spawn } from "child_process";
import { stat } from "fs/promises";
import path from "path";
import { FFMPEG } from "../../env";
import { track } from "../children";

/**
 * Narration with the machine's own voice — macOS `say`, which is free
 * and offline. Anywhere without it (a Linux server), the video simply
 * plays with its captions and any clip audio instead of failing.
 */

export function narrationAvailable(): boolean {
  return process.platform === "darwin";
}

function run(command: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = track(spawn(command, args, { windowsHide: true }));
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString().slice(-2000)));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`${command} failed to start: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve()
        : reject(new Error(`${command} exited ${code}: ${stderr.slice(-300)}`));
    });
  });
}

/**
 * Speaks `text` into an AAC file and returns how long it runs, so the
 * scene can be held for exactly as long as the sentence takes.
 */
export async function speak(options: {
  text: string;
  outPath: string;
  workDir: string;
  index: number;
  voice?: string;
}): Promise<number> {
  const aiff = path.join(options.workDir, `narration-${options.index}.aiff`);
  const args = ["-o", aiff];
  if (options.voice?.trim()) args.push("-v", options.voice.trim());
  // The text is its own argv entry, so quotes and punctuation are safe
  args.push("--", options.text);
  await run("say", args, 60_000);

  await run(
    FFMPEG,
    ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", aiff,
     "-ac", "2", "-ar", "48000", "-c:a", "aac", "-b:a", "160k", options.outPath],
    60_000,
  );
  const { size } = await stat(options.outPath);
  if (size === 0) throw new Error("narration produced an empty file");
  return probeDuration(options.outPath);
}

/** Length of an audio or video file in seconds. */
export async function probeDuration(filePath: string): Promise<number> {
  const { FFPROBE } = await import("../../env");
  return new Promise((resolve, reject) => {
    const child = track(
      spawn(
        FFPROBE,
        ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", filePath],
        { windowsHide: true },
      ),
    );
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", reject);
    child.on("close", () => {
      const seconds = Number(out.trim());
      Number.isFinite(seconds) && seconds > 0
        ? resolve(seconds)
        : reject(new Error(`could not read duration of ${path.basename(filePath)}`));
    });
  });
}
