import { mkdir, rm } from "fs/promises";
import os from "os";
import path from "path";
import { downloadToFile } from "./storage";

export interface WorkDir {
  dir: string;
  file: (name: string) => string;
  cleanup: () => Promise<void>;
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
