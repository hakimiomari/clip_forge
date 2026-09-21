import { spawn } from "child_process";
import { YTDLP } from "../../env";
import { track } from "../children";

/**
 * YouTube search through yt-dlp's `ytsearch` — no API key, and the same
 * binary the rest of the pipeline already uses.
 */

export interface Candidate {
  videoId: string;
  title: string;
  channel: string;
  durationSeconds: number;
  watchUrl: string;
}

/** Too short to hold a moment; too long to be worth analysing. */
const MIN_DURATION = 45;
const MAX_DURATION = 40 * 60;

function runYtDlp(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = track(spawn(YTDLP, args, { windowsHide: true }));
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("YouTube search timed out"));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString().slice(-4000)));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to start ${YTDLP}: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve(stdout)
        : reject(new Error(`yt-dlp search failed: ${stderr.slice(-300)}`));
    });
  });
}

/**
 * Finds candidate videos for a prompt. `--flat-playlist` keeps this to
 * one request: it returns ids, titles and durations without visiting
 * each video's page.
 */
export async function searchYouTube(
  query: string,
  limit: number,
): Promise<Candidate[]> {
  const stdout = await runYtDlp(
    [
      "--no-warnings",
      "--flat-playlist",
      "--dump-json",
      "--socket-timeout", "30",
      // Ask for extras: some results are unusable and get filtered below
      `ytsearch${Math.max(limit * 3, limit)}:${query}`,
    ],
    3 * 60_000,
  );

  const candidates: Candidate[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let row: {
      id?: string;
      title?: string;
      channel?: string;
      uploader?: string;
      duration?: number;
      live_status?: string;
    };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const duration = Number(row.duration);
    if (!row.id || !Number.isFinite(duration)) continue;
    // Live streams and premieres can't be seeked into reliably
    if (row.live_status && row.live_status !== "not_live") continue;
    if (duration < MIN_DURATION || duration > MAX_DURATION) continue;
    candidates.push({
      videoId: row.id,
      title: row.title ?? row.id,
      channel: row.channel ?? row.uploader ?? "Unknown channel",
      durationSeconds: duration,
      watchUrl: `https://www.youtube.com/watch?v=${row.id}`,
    });
    if (candidates.length >= limit) break;
  }
  return candidates;
}
