import type { Job } from "bullmq";
import type { CleanupFilesJob } from "@clipforge/shared-types";
import { deleteObject } from "../lib/storage";

/** cleanup-files: best-effort removal of orphaned storage objects. */
export async function processCleanup(job: Job<CleanupFilesJob>): Promise<void> {
  const failures: string[] = [];
  for (const key of job.data.storageKeys) {
    try {
      await deleteObject(key);
    } catch {
      failures.push(key);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Failed to delete ${failures.length} object(s): ${failures.slice(0, 5).join(", ")}`,
    );
  }
}
