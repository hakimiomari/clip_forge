import {
  Injectable,
  Logger,
  OnModuleDestroy,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import {
  QUEUES,
  type QueueName,
  type VideoImportJob,
  type TranscriptionJob,
  type CleanupFilesJob,
  type HighlightGenerationJob,
  type RenderVideoJob,
} from "@clipforge/shared-types";

/**
 * Producer side of the job pipeline. The API only enqueues; all heavy
 * work happens in the separate worker process. Never run FFmpeg or AI
 * calls inside HTTP handlers.
 */
@Injectable()
export class QueuesService implements OnModuleDestroy {
  private readonly logger = new Logger(QueuesService.name);
  private readonly connection: IORedis;
  private readonly queues = new Map<QueueName, Queue>();

  constructor(config: ConfigService) {
    this.connection = new IORedis(
      config.getOrThrow<string>("REDIS_URL"),
      // BullMQ requirement for blocking commands
      { maxRetriesPerRequest: null },
    );
  }

  private queue(name: QueueName): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, {
        connection: this.connection,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: "exponential", delay: 5_000 },
          removeOnComplete: { age: 24 * 3600, count: 500 },
          removeOnFail: { age: 7 * 24 * 3600 },
        },
      });
      this.queues.set(name, q);
    }
    return q;
  }

  async enqueueVideoImport(payload: VideoImportJob): Promise<string> {
    const job = await this.queue(QUEUES.VIDEO_IMPORT).add("import", payload);
    this.logger.log(`Enqueued video-import for project ${payload.projectId}`);
    return job.id ?? "";
  }

  async enqueueTranscription(payload: TranscriptionJob): Promise<string> {
    const job = await this.queue(QUEUES.TRANSCRIPTION).add(
      "transcribe",
      payload,
    );
    return job.id ?? "";
  }

  async enqueueCleanup(payload: CleanupFilesJob): Promise<void> {
    if (payload.storageKeys.length === 0) return;
    await this.queue(QUEUES.CLEANUP_FILES).add("cleanup", payload);
  }

  async enqueueHighlightGeneration(payload: HighlightGenerationJob): Promise<string> {
    const job = await this.queue(QUEUES.HIGHLIGHT_GENERATION).add(
      "generate",
      payload,
      // Analysis + LLM calls are not safely retryable mid-way — single attempt,
      // failure handling (status + refund) lives in the processor.
      { attempts: 1 },
    );
    this.logger.log(`Enqueued highlight-generation for project ${payload.projectId}`);
    return job.id ?? "";
  }

  async enqueueRenderVideo(payload: RenderVideoJob): Promise<string> {
    const job = await this.queue(QUEUES.RENDER_VIDEO).add("render", payload, {
      attempts: 1,
    });
    this.logger.log(`Enqueued render for clip ${payload.clipId}`);
    return job.id ?? "";
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
    this.connection.disconnect();
  }
}
