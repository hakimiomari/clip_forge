import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  RESEARCH_VIDEO_CREDITS,
  type ResearchScene,
  type ResearchVideoSummary,
} from "@clipforge/shared-types";
import { PrismaService } from "../prisma/prisma.service";
import { QueuesService } from "../queues/queues.service";
import { StorageService } from "../storage/storage.service";
import { UsageService } from "../usage/usage.service";
import { CreateResearchVideoDto } from "./dto/research.dto";

/** Statuses where the job is still working and a new one would collide. */
const BUSY = ["PENDING", "RESEARCHING", "BUILDING", "RENDERING"];

@Injectable()
export class ResearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueuesService,
    private readonly storage: StorageService,
    private readonly usage: UsageService,
  ) {}

  async create(userId: string, dto: CreateResearchVideoDto) {
    const prompt = dto.prompt.trim();
    if (!prompt) throw new BadRequestException("Enter a topic to research");

    // One build at a time per user: each one holds the single research
    // worker slot, so queueing several just makes them all slower
    const running = await this.prisma.researchVideo.count({
      where: { userId, status: { in: BUSY as never[] } },
    });
    if (running > 0) {
      throw new BadRequestException(
        "A research video is already being built — wait for it to finish.",
      );
    }

    await this.usage.spend(userId, RESEARCH_VIDEO_CREDITS, "RENDER_CLIP", {});

    const record = await this.prisma.researchVideo.create({
      data: {
        userId,
        prompt,
        format: dto.format,
        cartoonStyle: dto.cartoonStyle ?? "none",
        status: "PENDING",
        step: "Queued",
      },
    });
    try {
      await this.queues.enqueueResearchVideo({ researchId: record.id, userId });
    } catch (err) {
      await this.usage.refund(userId, RESEARCH_VIDEO_CREDITS, {});
      await this.prisma.researchVideo.update({
        where: { id: record.id },
        data: { status: "FAILED", error: "Could not queue the build", step: "Failed" },
      });
      throw err;
    }
    return this.toSummary(record);
  }

  async list(userId: string): Promise<ResearchVideoSummary[]> {
    const rows = await this.prisma.researchVideo.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return Promise.all(rows.map((row) => this.toSummary(row)));
  }

  async detail(id: string, userId: string): Promise<ResearchVideoSummary> {
    const row = await this.getOwned(id, userId);
    return this.toSummary(row, { includeScenes: true });
  }

  async remove(id: string, userId: string): Promise<void> {
    const row = await this.getOwned(id, userId);
    const keys = [row.storageKey, row.thumbnailKey].filter(
      (k): k is string => Boolean(k),
    );
    await this.prisma.researchVideo.delete({ where: { id } });
    await this.queues.enqueueCleanup({ storageKeys: keys });
  }

  /** Ownership check that hides existence, like the rest of the API. */
  private async getOwned(id: string, userId: string) {
    const row = await this.prisma.researchVideo.findUnique({ where: { id } });
    if (!row || row.userId !== userId) {
      throw new NotFoundException("Research video not found");
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
      cartoonStyle: string;
      progress: number;
      step: string | null;
      duration: number | null;
      storageKey: string | null;
      scenes: unknown;
      createdAt: Date;
    },
    options: { includeScenes?: boolean } = {},
  ): Promise<ResearchVideoSummary> {
    return {
      id: row.id,
      prompt: row.prompt,
      title: row.title,
      description: row.description,
      status: row.status as ResearchVideoSummary["status"],
      error: row.error,
      format: row.format,
      cartoonStyle: row.cartoonStyle as ResearchVideoSummary["cartoonStyle"],
      progress: row.progress,
      step: row.step,
      duration: row.duration,
      createdAt: row.createdAt.toISOString(),
      videoUrl: row.storageKey ? await this.storage.presignGet(row.storageKey) : null,
      ...(options.includeScenes
        ? { scenes: (row.scenes as ResearchScene[] | null) ?? null }
        : {}),
    };
  }
}
