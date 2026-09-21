import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  COMPILATION_CREDITS,
  type CompilationMoment,
  type CompilationSummary,
} from "@clipforge/shared-types";
import { PrismaService } from "../prisma/prisma.service";
import { QueuesService } from "../queues/queues.service";
import { StorageService } from "../storage/storage.service";
import { UsageService } from "../usage/usage.service";
import { CreateCompilationDto } from "./dto/compilation.dto";

/** Statuses where the job is still working. */
const BUSY = ["PENDING", "RESEARCHING", "BUILDING", "RENDERING"];

/**
 * Best-of compilations. They share the ResearchVideo table — same
 * prompt-to-video shape, same progress polling — and are told apart by
 * `kind`, so listing one never returns the other.
 */
@Injectable()
export class CompilationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueuesService,
    private readonly storage: StorageService,
    private readonly usage: UsageService,
  ) {}

  async create(userId: string, dto: CreateCompilationDto) {
    const prompt = dto.prompt.trim();
    if (!prompt) throw new BadRequestException("Describe what to compile");

    // One at a time: a compilation downloads and analyses several videos
    // and holds the single worker slot while it does
    const running = await this.prisma.researchVideo.count({
      where: { userId, kind: "COMPILATION", status: { in: BUSY as never[] } },
    });
    if (running > 0) {
      throw new BadRequestException(
        "A compilation is already being built — wait for it to finish.",
      );
    }

    await this.usage.spend(userId, COMPILATION_CREDITS, "RENDER_CLIP", {});

    const record = await this.prisma.researchVideo.create({
      data: {
        userId,
        kind: "COMPILATION",
        prompt,
        format: dto.format,
        targetSeconds: dto.targetSeconds,
        status: "PENDING",
        step: "Queued",
      },
    });
    try {
      await this.queues.enqueueCompilation({ compilationId: record.id, userId });
    } catch (err) {
      await this.usage.refund(userId, COMPILATION_CREDITS, {});
      await this.prisma.researchVideo.update({
        where: { id: record.id },
        data: { status: "FAILED", error: "Could not queue the build", step: "Failed" },
      });
      throw err;
    }
    return this.toSummary(record);
  }

  async list(userId: string): Promise<CompilationSummary[]> {
    const rows = await this.prisma.researchVideo.findMany({
      where: { userId, kind: "COMPILATION" },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return Promise.all(rows.map((row) => this.toSummary(row)));
  }

  async detail(id: string, userId: string): Promise<CompilationSummary> {
    const row = await this.getOwned(id, userId);
    return this.toSummary(row, { includeMoments: true });
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
    if (!row || row.userId !== userId || row.kind !== "COMPILATION") {
      throw new NotFoundException("Compilation not found");
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
      targetSeconds: number | null;
      progress: number;
      step: string | null;
      duration: number | null;
      storageKey: string | null;
      scenes: unknown;
      createdAt: Date;
    },
    options: { includeMoments?: boolean } = {},
  ): Promise<CompilationSummary> {
    return {
      id: row.id,
      prompt: row.prompt,
      title: row.title,
      description: row.description,
      status: row.status as CompilationSummary["status"],
      error: row.error,
      format: row.format,
      targetSeconds: row.targetSeconds,
      progress: row.progress,
      step: row.step,
      duration: row.duration,
      createdAt: row.createdAt.toISOString(),
      videoUrl: row.storageKey ? await this.storage.presignGet(row.storageKey) : null,
      ...(options.includeMoments
        ? { moments: (row.scenes as CompilationMoment[] | null) ?? null }
        : {}),
    };
  }
}
