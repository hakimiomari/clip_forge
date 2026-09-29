import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  GENERATED_ENGINES,
  GENERATED_VIDEO_CREDITS,
  pickGeneratedEngine,
  type GeneratedEngine,
  type GeneratedShot,
  type GeneratedVideoSummary,
} from "@clipforge/shared-types";
import { PrismaService } from "../prisma/prisma.service";
import { QueuesService } from "../queues/queues.service";
import { StorageService } from "../storage/storage.service";
import { UsageService } from "../usage/usage.service";
import { CreateGeneratedVideoDto } from "./dto/generated.dto";

/** Statuses where the job is still working. */
const BUSY = ["PENDING", "RESEARCHING", "BUILDING", "RENDERING"];

/**
 * AI videos share the ResearchVideo table — same prompt-to-video shape,
 * same progress polling — under kind "GENERATED".
 */
@Injectable()
export class GeneratedService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueuesService,
    private readonly storage: StorageService,
    private readonly usage: UsageService,
  ) {}

  engine() {
    const engine = pickGeneratedEngine(process.env);
    return { engine, ...GENERATED_ENGINES[engine] };
  }

  async create(userId: string, dto: CreateGeneratedVideoDto) {
    const prompt = dto.prompt.trim();
    if (!prompt) throw new BadRequestException("Describe the video to make");

    // One at a time: every shot is a generation the engine bills for
    const running = await this.prisma.researchVideo.count({
      where: { userId, kind: "GENERATED", status: { in: BUSY as never[] } },
    });
    if (running > 0) {
      throw new BadRequestException(
        "A video is already being generated — wait for it to finish.",
      );
    }

    await this.usage.spend(userId, GENERATED_VIDEO_CREDITS, "RENDER_CLIP", {});

    const record = await this.prisma.researchVideo.create({
      data: {
        userId,
        kind: "GENERATED",
        prompt,
        format: dto.format,
        targetSeconds: dto.targetSeconds,
        style: dto.style,
        status: "PENDING",
        step: "Queued",
      },
    });
    try {
      await this.queues.enqueueGeneratedVideo({ generatedId: record.id, userId });
    } catch (err) {
      await this.usage.refund(userId, GENERATED_VIDEO_CREDITS, {});
      await this.prisma.researchVideo.update({
        where: { id: record.id },
        data: { status: "FAILED", error: "Could not queue the build", step: "Failed" },
      });
      throw err;
    }
    return this.toSummary(record);
  }

  /**
   * Generates a failed video again with the same prompt and settings.
   * The failure already refunded its credits, so this charges afresh.
   */
  async retry(id: string, userId: string): Promise<GeneratedVideoSummary> {
    const existing = await this.getOwned(id, userId);
    if (existing.status !== "FAILED") {
      throw new BadRequestException("Only a failed video can be generated again");
    }
    const running = await this.prisma.researchVideo.count({
      where: { userId, kind: "GENERATED", status: { in: BUSY as never[] } },
    });
    if (running > 0) {
      throw new BadRequestException(
        "A video is already being generated — wait for it to finish.",
      );
    }

    await this.usage.spend(userId, GENERATED_VIDEO_CREDITS, "RENDER_CLIP", {});
    const record = await this.prisma.researchVideo.update({
      where: { id },
      data: {
        status: "PENDING",
        step: "Queued",
        error: null,
        progress: 0,
        // Nothing from the last attempt is reused; clear it so a
        // half-built result can never be mistaken for this run's
        engine: null,
        scenes: undefined,
        storageKey: null,
        thumbnailKey: null,
        duration: null,
        description: null,
      },
    });
    try {
      await this.queues.enqueueGeneratedVideo({ generatedId: id, userId });
    } catch (err) {
      await this.usage.refund(userId, GENERATED_VIDEO_CREDITS, {});
      await this.prisma.researchVideo.update({
        where: { id },
        data: { status: "FAILED", error: "Could not queue the build", step: "Failed" },
      });
      throw err;
    }
    return this.toSummary(record);
  }

  async list(userId: string): Promise<GeneratedVideoSummary[]> {
    const rows = await this.prisma.researchVideo.findMany({
      where: { userId, kind: "GENERATED" },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return Promise.all(rows.map((row) => this.toSummary(row)));
  }

  async detail(id: string, userId: string): Promise<GeneratedVideoSummary> {
    const row = await this.getOwned(id, userId);
    return this.toSummary(row, { includeShots: true });
  }

  async remove(id: string, userId: string): Promise<void> {
    const row = await this.getOwned(id, userId);
    const keys = [row.storageKey, row.thumbnailKey].filter(
      (k): k is string => Boolean(k),
    );
    await this.prisma.researchVideo.delete({ where: { id } });
    await this.queues.enqueueCleanup({ storageKeys: keys });
  }

  private async getOwned(id: string, userId: string) {
    const row = await this.prisma.researchVideo.findUnique({ where: { id } });
    if (!row || row.userId !== userId || row.kind !== "GENERATED") {
      throw new NotFoundException("Video not found");
    }
    return row;
  }

  private async toSummary(
    row: {
      id: string;
      prompt: string;
      title: string | null;
      description: string | null;
      status: string;
      error: string | null;
      format: string;
      style: string;
      engine: string | null;
      targetSeconds: number | null;
      progress: number;
      step: string | null;
      duration: number | null;
      storageKey: string | null;
      scenes: unknown;
      createdAt: Date;
    },
    options: { includeShots?: boolean } = {},
  ): Promise<GeneratedVideoSummary> {
    return {
      id: row.id,
      prompt: row.prompt,
      title: row.title,
      description: row.description,
      status: row.status as GeneratedVideoSummary["status"],
      error: row.error,
      format: row.format,
      style: row.style,
      engine: (row.engine as GeneratedEngine | null) ?? null,
      targetSeconds: row.targetSeconds,
      progress: row.progress,
      step: row.step,
      duration: row.duration,
      createdAt: row.createdAt.toISOString(),
      videoUrl: row.storageKey ? await this.storage.presignGet(row.storageKey) : null,
      ...(options.includeShots
        ? { shots: (row.scenes as GeneratedShot[] | null) ?? null }
        : {}),
    };
  }
}
