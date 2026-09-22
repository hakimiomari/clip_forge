import { spawn } from "child_process";
import type { CompilationFreshness } from "@clipforge/shared-types";
import { YTDLP } from "../../env";
import { track } from "../children";

/**
 * YouTube search through yt-dlp — no API key, and the same binary the
 * rest of the pipeline already uses.
 *
 * "Latest" needs care: YouTube *ignores* the sort-by-upload-date
 * parameter for this client (a date-sorted search still returns videos
 * from 2020), and yt-dlp removed its `ytsearchdate:` prefix. The
 * upload-date *filters* do work, so recency comes from searching with a
 * "this month" / "this year" filter, not from sorting.
 */

export interface Candidate {
  videoId: string;
  title: string;
  channel: string;
  durationSeconds: number;
  watchUrl: string;
  /** Found through a recent-uploads filter rather than all-time search */
  recent: boolean;
}

/** Too short to hold a moment. */
const MIN_DURATION = 45;
/**
 * Long enough for a full ODI or a day of a Test. Long videos are now
 * affordable because only low-bitrate audio is analysed, and a replay
 * heatmap (when present) avoids even that.
 */
const MAX_DURATION = 8 * 60 * 60;

/** YouTube search-results filters (the `sp` parameter). */
const FILTERS = {
  thisMonth: "EgIIBA%3D%3D",
  thisYear: "EgIIBQ%3D%3D",
} as const;

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

/** One search request, returning usable candidates in result order. */
async function searchOnce(
  target: string,
  max: number,
  recent: boolean,
): Promise<Candidate[]> {
  const stdout = await runYtDlp(
    [
      "--no-warnings",
      "--flat-playlist",
      "--dump-json",
      "--socket-timeout", "30",
      "--playlist-end", String(max),
      target,
    ],
    3 * 60_000,
  );

  const found: Candidate[] = [];
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
    found.push({
      videoId: row.id,
      title: row.title ?? row.id,
      channel: row.channel ?? row.uploader ?? "Unknown channel",
      durationSeconds: duration,
      watchUrl: `https://www.youtube.com/watch?v=${row.id}`,
      recent,
    });
  }
  return found;
}

function filteredSearchUrl(query: string, filter: string): string {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=${filter}`;
}

/**
 * Interleaves several ranked lists, dropping duplicates, so a mix of
 * all-time and recent results alternates instead of one pool crowding
 * out the other.
 */
export function interleave(lists: Candidate[][], limit: number): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest && out.length < limit; i++) {
    for (const list of lists) {
      const candidate = list[i];
      if (!candidate || seen.has(candidate.videoId)) continue;
      seen.add(candidate.videoId);
      out.push(candidate);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/**
 * Finds candidate videos for a prompt.
 *
 * - all_time: YouTube's relevance ranking — the established classics
 * - mix:      relevance interleaved with uploads from this year
 * - latest:   uploads from this month, topped up from this year
 */
export async function searchYouTube(
  query: string,
  limit: number,
  freshness: CompilationFreshness = "mix",
): Promise<Candidate[]> {
  // Ask each pool for extras — some results are filtered out above
  const per = limit * 2;
  const pools: Array<Promise<Candidate[]>> = [];

  if (freshness === "all_time" || freshness === "mix") {
    pools.push(searchOnce(`ytsearch${per}:${query}`, per, false));
  }
  if (freshness === "mix" || freshness === "latest") {
    pools.push(searchOnce(filteredSearchUrl(query, FILTERS.thisYear), per, true));
  }
  if (freshness === "latest") {
    // This month first, so the newest uploads lead
    pools.unshift(searchOnce(filteredSearchUrl(query, FILTERS.thisMonth), per, true));
  }

  // A failing pool (a filter YouTube stops honouring) shouldn't sink the
  // search while another still returns results
  const settled = await Promise.allSettled(pools);
  const lists = settled
    .filter((r): r is PromiseFulfilledResult<Candidate[]> => r.status === "fulfilled")
    .map((r) => r.value);
  if (lists.length === 0) {
    const first = settled.find((r) => r.status === "rejected") as PromiseRejectedResult;
    throw first.reason instanceof Error ? first.reason : new Error(String(first.reason));
  }
  return interleave(lists, limit);
}
