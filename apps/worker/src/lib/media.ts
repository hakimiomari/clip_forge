import { mkdir, readdir, rm, stat } from "fs/promises";
import os from "os";
import path from "path";
import { downloadToFile } from "./storage";

export interface WorkDir {
  dir: string;
  file: (name: string) => string;
  cleanup: () => Promise<void>;
}

/**
 * Deletes work dirs left behind by jobs that were killed before their
 * `finally` could run (a crash, an OOM kill, a dev hot-reload). Media
 * scratch is large — a single interrupted import can strand hundreds of
 * megabytes — so the worker sweeps on startup.
 */
export async function cleanupStaleWorkDirs(
  maxAgeMs = 6 * 3600_000,
): Promise<number> {
  const root = path.join(os.tmpdir(), "clipforge");
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return 0; // nothing has run yet
  }
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const entry of entries) {
    const dir = path.join(root, entry);
    try {
      const info = await stat(dir);
      if (!info.isDirectory() || info.mtimeMs >= cutoff) continue;
      await rm(dir, { recursive: true, force: true });
      removed++;
    } catch {
      // Raced with another sweep, or not ours to delete — skip it
    }
  }
  return removed;
}

/** Creates an isolated temp directory for one job run. */
export async function createWorkDir(label: string): Promise<WorkDir> {
  const dir = path.join(
    os.tmpdir(),
    "clipforge",
    `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await mkdir(dir, { recursive: true });
  return {
    dir,
    file: (name: string) => path.join(dir, name),
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/** Downloads a storage object into the work dir, keeping its extension. */
export async function fetchToWorkDir(
  work: WorkDir,
  storageKey: string,
  baseName: string,
): Promise<string> {
  const ext = path.extname(storageKey) || ".bin";
  const local = work.file(`${baseName}${ext}`);
  await downloadToFile(storageKey, local);
  return local;
}
