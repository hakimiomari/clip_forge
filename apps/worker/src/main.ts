import { Worker, type Processor } from "bullmq";
import IORedis from "ioredis";
import { QUEUES } from "@clipforge/shared-types";
import { env } from "./env";
import { processVideoImport } from "./processors/video-import.processor";
import { processCleanup } from "./processors/cleanup.processor";
import { closeProgressPublisher } from "./lib/progress";
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
  { queue: QUEUES.CLEANUP_FILES, processor: processCleanup, concurrency: 5 },
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
  });
  worker.on("error", (err) => {
    console.error(`[${queue}] worker error: ${err.message}`);
  });
  return worker;
});

console.log(
  `ClipForge worker started — listening on: ${registry.map((r) => r.queue).join(", ")}`,
);

async function shutdown(signal: string): Promise<void> {
  console.log(`\n${signal} received, shutting down workers…`);
  await Promise.allSettled(workers.map((w) => w.close()));
  closeProgressPublisher();
  await getPrismaClient().$disconnect();
  connection.disconnect();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
