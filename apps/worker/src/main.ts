import { Worker, type Processor } from "bullmq";
import IORedis from "ioredis";
import { QUEUES } from "@clipforge/shared-types";
import { env } from "./env";
import { processVideoImport } from "./processors/video-import.processor";
import { processCleanup } from "./processors/cleanup.processor";
import { processHighlightGeneration } from "./processors/highlight-generation.processor";
import { processRenderVideo } from "./processors/render-video.processor";
import { processFilmstrip } from "./processors/filmstrip.processor";
import { processResearchVideo } from "./processors/research-video.processor";
import { closeProgressPublisher } from "./lib/progress";
import { checkFfmpegCapabilities } from "./lib/ffmpeg";
import { finalizeStalledJob, isStalledFailure } from "./lib/stalled";
import { killTrackedChildren } from "./lib/children";
import { cleanupStaleWorkDirs } from "./lib/media";
import { closeRenderQueue } from "./lib/render-queue";
import { getPrismaClient } from "@clipforge/database";

/**
 * ClipForge worker — consumes BullMQ queues and performs all heavy
 * media/AI work outside the API process.
 *
 * Milestone 1 registers: video-import, cleanup-files.
 * Milestone 2 adds: transcription, highlight-generation.
 * Milestone 3 adds: clip-generation, caption-generation, render-video,
 *                   quality-check.
 */

const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const registry: Array<{ queue: string; processor: Processor<any>; concurrency: number }> = [
  { queue: QUEUES.VIDEO_IMPORT, processor: processVideoImport, concurrency: 2 },
  { queue: QUEUES.HIGHLIGHT_GENERATION, processor: processHighlightGeneration, concurrency: 1 },
  { queue: QUEUES.RENDER_VIDEO, processor: processRenderVideo, concurrency: 1 },
  { queue: QUEUES.CLEANUP_FILES, processor: processCleanup, concurrency: 5 },
  { queue: QUEUES.FILMSTRIP, processor: processFilmstrip, concurrency: 2 },
  { queue: QUEUES.RESEARCH_VIDEO, processor: processResearchVideo, concurrency: 1 },
];

const workers = registry.map(({ queue, processor, concurrency }) => {
  const worker = new Worker(queue, processor, { connection, concurrency });
  worker.on("completed", (job) => {
    console.log(`[${queue}] job ${job.id} completed`);
  });
  worker.on("failed", (job, err) => {
    console.error(
      `[${queue}] job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`,
    );
    // A stalled job never reached its processor's catch — finalise it here
    if (job && isStalledFailure(err)) {
      void finalizeStalledJob(queue, job).catch((e: Error) =>
        console.error(`[${queue}] could not finalise stalled job ${job.id}: ${e.message}`),
      );
    }
  });
  worker.on("error", (err) => {
    console.error(`[${queue}] worker error: ${err.message}`);
  });
  return worker;
});

console.log(
  `ClipForge worker started — listening on: ${registry.map((r) => r.queue).join(", ")}`,
);

void checkFfmpegCapabilities().catch((err: Error) => {
  console.error(`ffmpeg check failed: ${err.message}`);
});

// Reclaim scratch space from jobs that were killed mid-run
void cleanupStaleWorkDirs()
  .then((removed) => {
    if (removed > 0) console.log(`Cleaned up ${removed} stale work director${removed === 1 ? "y" : "ies"}`);
  })
  .catch((err: Error) => console.error(`Work dir cleanup failed: ${err.message}`));

async function shutdown(signal: string): Promise<void> {
  console.log(`\n${signal} received, shutting down workers…`);
  // Stop media children first so in-flight jobs fail fast (and get
  // finalised as stalled/failed) instead of orphaning ffmpeg/yt-dlp
  const killed = killTrackedChildren();
  if (killed > 0) console.log(`Stopped ${killed} running media process(es)`);
  await Promise.allSettled(workers.map((w) => w.close(true)));
  await closeRenderQueue().catch(() => undefined);
  closeProgressPublisher();
  await getPrismaClient().$disconnect();
  connection.disconnect();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGHUP", () => void shutdown("SIGHUP"));
// Last resort for exits that skip the handlers above (uncaught crash)
process.on("exit", () => killTrackedChildren());
