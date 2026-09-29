import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  downloadExtension,
  MAX_ACTIVE_DOWNLOADS,
  type DownloadQuality,
  type DownloadStatus,
  type DownloadSummary,
} from "@clipforge/shared-types";
import { downloadFileName } from "../common/file-names";
import { PrismaService } from "../prisma/prisma.service";
import { extractYouTubeId } from "../projects/projects.service";
import { QueuesService } from "../queues/queues.service";
import { StorageService } from "../storage/storage.service";
import { CreateDownloadDto } from "./dto/download.dto";

const WORKING = ["PENDING", "DOWNLOADING", "SAVING"];

type DownloadRow = {
  id: string;
  url: string;
  videoId: string;
  title: string | null;
  channel: string | null;
  duration: number | null;
  quality: string;
  status: string;
  progress: number;
  error: string | null;
  storageKey: string | null;
  sizeBytes: bigint | null;
  width: number | null;
  height: number | null;
  createdAt: Date;
};

/**
 * Downloads: YouTube videos saved as files, with no project. Free — the
 * worker only fetches and stores; nothing is analysed or rendered.
 */
@Injectable()
export class DownloadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueuesService,
    private readonly storage: StorageService,
  ) {}

  async create(userId: string, dto: CreateDownloadDto): Promise<DownloadSummary> {
    const videoId = extractYouTubeId(dto.url.trim());
    if (!videoId) {
      throw new BadRequestException(
        "That isn't a YouTube video link — paste one like https://www.youtube.com/watch?v=…",
      );
    }
    await this.assertRoom(userId);

    const record = await this.prisma.download.create({
      data: {
        userId,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        videoId,
        quality: dto.quality,
        status: "PENDING",
      },
    });
    await this.enqueue(record.id, userId);
    return this.toSummary(record);
  }

  async list(userId: string): Promise<DownloadSummary[]> {
    const rows = await this.prisma.download.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return Promise.all(rows.map((row) => this.toSummary(row)));
  }

  async detail(id: string, userId: string): Promise<DownloadSummary> {
    return this.toSummary(await this.getOwned(id, userId));
  }

  /** Starts a failed download again with the same link and quality. */
  async retry(id: string, userId: string): Promise<DownloadSummary> {
    const existing = await this.getOwned(id, userId);
    if (existing.status !== "FAILED") {
      throw new BadRequestException("Only a failed download can be tried again");
    }
    await this.assertRoom(userId);
    const record = await this.prisma.download.update({
      where: { id },
      data: { status: "PENDING", progress: 0, error: null },
    });
    await this.enqueue(id, userId);
    return this.toSummary(record);
  }

  /** Deleting a running download cancels it; the worker cleans up after itself. */
  async remove(id: string, userId: string): Promise<void> {
    const row = await this.getOwned(id, userId);
    await this.prisma.download.delete({ where: { id } });
    if (row.storageKey) {
      await this.queues.enqueueCleanup({ storageKeys: [row.storageKey] });
    }
  }

  private async assertRoom(userId: string): Promise<void> {
    const active = await this.prisma.download.count({
      where: { userId, status: { in: WORKING } },
    });
    if (active >= MAX_ACTIVE_DOWNLOADS) {
      throw new BadRequestException(
        `You already have ${active} downloads under way — wait for one to finish.`,
      );
    }
  }

  private async enqueue(id: string, userId: string): Promise<void> {
    try {
      await this.queues.enqueueVideoDownload({ downloadId: id, userId });
    } catch (err) {
      await this.prisma.download.updateMany({
        where: { id },
        data: { status: "FAILED", error: "Could not queue the download" },
      });
      throw err;
    }
  }

  private async getOwned(id: string, userId: string): Promise<DownloadRow> {
    const row = await this.prisma.download.findUnique({ where: { id } });
    if (!row || row.userId !== userId) throw new NotFoundException("Download not found");
    return row;
  }

  private async toSummary(row: DownloadRow): Promise<DownloadSummary> {
    const quality = row.quality as DownloadQuality;
    const fileName = downloadFileName(row.title, row.videoId, downloadExtension(quality));
    const ready = row.status === "READY" && Boolean(row.storageKey);
    return {
      id: row.id,
      url: row.url,
      videoId: row.videoId,
      title: row.title,
      channel: row.channel,
      thumbnailUrl: `https://i.ytimg.com/vi/${row.videoId}/mqdefault.jpg`,
      duration: row.duration,
      quality,
      status: row.status as DownloadStatus,
      progress: row.progress,
      error: row.error,
      sizeBytes: row.sizeBytes != null ? Number(row.sizeBytes) : null,
      width: row.width,
      height: row.height,
      createdAt: row.createdAt.toISOString(),
      fileName,
      fileUrl: ready
        ? await this.storage.presignGet(row.storageKey!, { downloadFileName: fileName })
        : null,
    };
  }
}
