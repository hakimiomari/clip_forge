import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  MAX_ACTIVE_PHOTO_SETS,
  photoStamp,
  type PhotoPickMode,
  type PhotoSetStatus,
  type PhotoSetSummary,
  type StoredPhoto,
} from "@clipforge/shared-types";
import { downloadFileName } from "../common/file-names";
import { PrismaService } from "../prisma/prisma.service";
import { extractYouTubeId } from "../projects/projects.service";
import { QueuesService } from "../queues/queues.service";
import { StorageService } from "../storage/storage.service";
import { CreatePhotoSetDto } from "./dto/photos.dto";

const WORKING = ["PENDING", "FINDING", "CAPTURING", "SAVING"];

type PhotoSetRow = {
  id: string;
  url: string;
  videoId: string;
  title: string | null;
  channel: string | null;
  duration: number | null;
  mode: string;
  count: number;
  status: string;
  progress: number;
  step: string | null;
  error: string | null;
  photos: unknown;
  zipKey: string | null;
  zipBytes: bigint | null;
  createdAt: Date;
};

/** Video to photos: stills from a YouTube video, with no project. Free. */
@Injectable()
export class PhotosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueuesService,
    private readonly storage: StorageService,
  ) {}

  async create(userId: string, dto: CreatePhotoSetDto): Promise<PhotoSetSummary> {
    const videoId = extractYouTubeId(dto.url.trim());
    if (!videoId) {
      throw new BadRequestException(
        "That isn't a YouTube video link — paste one like https://www.youtube.com/watch?v=…",
      );
    }
    await this.assertRoom(userId);
    const record = await this.prisma.photoSet.create({
      data: {
        userId,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        videoId,
        mode: dto.mode,
        count: dto.count,
        status: "PENDING",
        step: "Queued",
      },
    });
    await this.enqueue(record.id, userId);
    return this.toSummary(record);
  }

  async list(userId: string): Promise<PhotoSetSummary[]> {
    const rows = await this.prisma.photoSet.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 30,
    });
    return Promise.all(rows.map((row) => this.toSummary(row)));
  }

  async detail(id: string, userId: string): Promise<PhotoSetSummary> {
    return this.toSummary(await this.getOwned(id, userId));
  }

  /** Takes a failed set again with the same link and settings. */
  async retry(id: string, userId: string): Promise<PhotoSetSummary> {
    const existing = await this.getOwned(id, userId);
    if (existing.status !== "FAILED") {
      throw new BadRequestException("Only a failed set can be tried again");
    }
    await this.assertRoom(userId);
    const record = await this.prisma.photoSet.update({
      where: { id },
      data: { status: "PENDING", progress: 0, step: "Queued", error: null },
    });
    await this.enqueue(id, userId);
    return this.toSummary(record);
  }

  /** Deleting a running set cancels it; the worker cleans up after itself. */
  async remove(id: string, userId: string): Promise<void> {
    const row = await this.getOwned(id, userId);
    const keys = [
      ...this.storedPhotos(row).map((p) => p.key),
      row.zipKey,
    ].filter((k): k is string => Boolean(k));
    await this.prisma.photoSet.delete({ where: { id } });
    if (keys.length > 0) await this.queues.enqueueCleanup({ storageKeys: keys });
  }

  private async assertRoom(userId: string): Promise<void> {
    const active = await this.prisma.photoSet.count({
      where: { userId, status: { in: WORKING } },
    });
    if (active >= MAX_ACTIVE_PHOTO_SETS) {
      throw new BadRequestException(
        `You already have ${active} photo sets being made — wait for one to finish.`,
      );
    }
  }

  private async enqueue(id: string, userId: string): Promise<void> {
    try {
      await this.queues.enqueueVideoPhotos({ photoSetId: id, userId });
    } catch (err) {
      await this.prisma.photoSet.updateMany({
        where: { id },
        data: { status: "FAILED", error: "Could not queue the job", step: "Failed" },
      });
      throw err;
    }
  }

  private async getOwned(id: string, userId: string): Promise<PhotoSetRow> {
    const row = await this.prisma.photoSet.findUnique({ where: { id } });
    if (!row || row.userId !== userId) throw new NotFoundException("Photo set not found");
    return row;
  }

  private storedPhotos(row: PhotoSetRow): StoredPhoto[] {
    return Array.isArray(row.photos) ? (row.photos as StoredPhoto[]) : [];
  }

  private async toSummary(row: PhotoSetRow): Promise<PhotoSetSummary> {
    const ready = row.status === "READY";
    const zipFileName = downloadFileName(
      row.title ? `${row.title} photos` : null,
      `${row.videoId} photos`,
      "zip",
    );
    const photos = ready
      ? await Promise.all(
          this.storedPhotos(row).map(async (p) => {
            const fileName = downloadFileName(
              row.title ? `${row.title} ${photoStamp(p.time)}` : null,
              `${row.videoId} ${photoStamp(p.time)}`,
              "jpg",
            );
            return {
              index: p.index,
              time: p.time,
              width: p.width,
              height: p.height,
              sizeBytes: p.sizeBytes,
              viewUrl: await this.storage.presignGet(p.key),
              downloadUrl: await this.storage.presignGet(p.key, { downloadFileName: fileName }),
              fileName,
            };
          }),
        )
      : null;
    return {
      id: row.id,
      url: row.url,
      videoId: row.videoId,
      title: row.title,
      channel: row.channel,
      thumbnailUrl: `https://i.ytimg.com/vi/${row.videoId}/mqdefault.jpg`,
      duration: row.duration,
      mode: row.mode as PhotoPickMode,
      count: row.count,
      status: row.status as PhotoSetStatus,
      progress: row.progress,
      step: row.step,
      error: row.error,
      createdAt: row.createdAt.toISOString(),
      photos,
      zipUrl:
        ready && row.zipKey
          ? await this.storage.presignGet(row.zipKey, { downloadFileName: zipFileName })
          : null,
      zipFileName,
      zipBytes: row.zipBytes != null ? Number(row.zipBytes) : null,
    };
  }
}
