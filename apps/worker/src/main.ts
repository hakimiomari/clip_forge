import { Worker, type Processor } from "bullmq";
import IORedis from "ioredis";
import { QUEUES } from "@clipforge/shared-types";
import { env, FFMPEG, FFPROBE } from "./env";
import { processVideoImport } from "./processors/video-import.processor";
import { processCleanup } from "./processors/cleanup.processor";
import { processHighlightGeneration } from "./processors/highlight-generation.processor";
import { processRenderVideo } from "./processors/render-video.processor";
import { processFilmstrip } from "./processors/filmstrip.processor";
import { processResearchVideo } from "./processors/research-video.processor";
import { processCompilation } from "./processors/compilation.processor";
import { processGeneratedVideo } from "./processors/generated-video.processor";
import { processSourceDownload } from "./processors/source-download.processor";
import { processVideoDownload } from "./processors/video-download.processor";
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

/**
 * ioredis reports a refused connection as an AggregateError whose own
 * message is empty, and every queue reports it separately on every
 * retry — eight blank "worker error:" lines a second, which buries
 * whatever else the log had to say. These helpers turn that into one
 * actionable line, repeated at most every 15 seconds.
 */
function describeError(err: unknown): string {
  const e = err as {
    code?: string;
    message?: string;
    name?: string;
    errors?: Array<{ code?: string; message?: string }>;
  };
  const code = e?.code ?? e?.errors?.find((inner) => inner?.code)?.code;
  const message =
    e?.message || e?.errors?.find((inner) => inner?.message)?.message || "";
  if (code) return message ? `${code}: ${message}` : code;
  return message || e?.name || String(err);
}

let lastConnectionNotice = 0;
function reportedAsConnectionProblem(err: unknown): boolean {
  const text = describeError(err);
  if (!/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EPIPE/.test(text)) return false;
  const now = Date.now();
  if (now - lastConnectionNotice < 15_000) return true;
  lastConnectionNotice = now;
  console.error("");
  console.error(`  Cannot reach Redis at ${env.REDIS_URL} (${text}).`);
  console.error("  Start the infrastructure with:  pnpm infra:up");
  console.error("  Queues reconnect on their own once it is up.");
  console.error("");
  return true;
}

// Without a listener ioredis prints its own "Unhandled error event" noise
connection.on("error", (err) => {
  if (reportedAsConnectionProblem(err)) return;
  console.error(`Redis connection error: ${describeError(err)}`);
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const registry: Array<{ queue: string; processor: Processor<any>; concurrency: number }> = [
  { queue: QUEUES.VIDEO_IMPORT, processor: processVideoImport, concurrency: 2 },
  { queue: QUEUES.HIGHLIGHT_GENERATION, processor: processHighlightGeneration, concurrency: 1 },
  { queue: QUEUES.RENDER_VIDEO, processor: processRenderVideo, concurrency: 1 },
  { queue: QUEUES.CLEANUP_FILES, processor: processCleanup, concurrency: 5 },
  { queue: QUEUES.FILMSTRIP, processor: processFilmstrip, concurrency: 2 },
  { queue: QUEUES.RESEARCH_VIDEO, processor: processResearchVideo, concurrency: 1 },
  { queue: QUEUES.COMPILATION, processor: processCompilation, concurrency: 1 },
  { queue: QUEUES.GENERATED_VIDEO, processor: processGeneratedVideo, concurrency: 1 },
  { queue: QUEUES.SOURCE_DOWNLOAD, processor: processSourceDownload, concurrency: 1 },
  { queue: QUEUES.VIDEO_DOWNLOAD, processor: processVideoDownload, concurrency: 1 },
];

/**
 * How long a job's lock survives without renewal. BullMQ's 30s default
 * treats any longer pause as a dead worker and re-runs the job from the
 * start — and macOS delays background timers on an idle machine well
 * past 30s, which was restarting 30-minute renders. Two minutes still
 * catches a worker that really died.
 */
const LOCK_DURATION_MS = 120_000;

const workers = registry.map(({ queue, processor, concurrency }) => {
  const worker = new Worker(queue, processor, {
    connection,
    concurrency,
    lockDuration: LOCK_DURATION_MS,
  });
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
    // Redis being down is one fault, not one per queue — report it once
    if (reportedAsConnectionProblem(err)) return;
    console.error(`[${queue}] worker error: ${describeError(err)}`);
  });
  return worker;
});

console.log(
  `ClipForge worker started — listening on: ${registry.map((r) => r.queue).join(", ")}`,
);

// Which binaries this worker resolved, so a stale process pointing at
// the wrong ffmpeg is obvious in the log rather than at job time
console.log(`  ffmpeg:  ${FFMPEG}`);
console.log(`  ffprobe: ${FFPROBE}`);

void checkFfmpegCapabilities().catch((err: Error) => {
  // A blocked or missing binary fails every media job, so say plainly
  // what is wrong instead of leaving each job to report it obscurely
  const blocked = /Application Control|not permitted|EACCES|EPERM/i.test(err.message);
  const missing = /ENOENT|not recognized|failed to start/i.test(err.message);
  console.error(`\n  ffmpeg is not usable: ${err.message}`);
  if (blocked) {
    console.error(
      `  Windows is refusing to run it (Smart App Control blocks unsigned builds).\n` +
        `  Point FFMPEG_PATH/FFPROBE_PATH in .env at a build Windows trusts.`,
    );
  } else if (missing) {
    console.error(
      `  Install ffmpeg, or set FFMPEG_PATH/FFPROBE_PATH in .env.`,
    );
  }
  console.error(`  Media jobs will fail until this is fixed.\n`);
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
