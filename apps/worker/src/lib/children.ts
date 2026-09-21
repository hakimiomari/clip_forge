import type { ChildProcess } from "child_process";

/**
 * Registry of every ffmpeg/ffprobe/yt-dlp child the worker has running.
 * When the worker process exits (SIGTERM from a supervisor, dev
 * hot-reload, crash) the children would otherwise be orphaned and keep
 * decoding — for a streamed YouTube source that means hours of wasted
 * CPU and bandwidth. `killTrackedChildren` is called from the shutdown
 * path so nothing outlives the job that started it.
 */
const children = new Set<ChildProcess>();

export function track<T extends ChildProcess>(child: T): T {
  children.add(child);
  child.once("close", () => children.delete(child));
  child.once("error", () => children.delete(child));
  return child;
}

/**
 * Kills a child and everything it started. yt-dlp hands section
 * downloads to its own ffmpeg; killing only yt-dlp leaves that ffmpeg
 * holding a dead YouTube connection forever. Children spawned with
 * `detached: true` lead their own process group, so the whole group
 * goes; others fall back to the single process.
 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): void {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Not a group leader — kill just the child below
    }
  }
  child.kill(signal);
}

export function killTrackedChildren(signal: NodeJS.Signals = "SIGKILL"): number {
  let killed = 0;
  for (const child of children) {
    if (child.exitCode === null && !child.killed) {
      killTree(child, signal);
      killed++;
    }
  }
  children.clear();
  return killed;
}
