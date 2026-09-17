import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import type { Prisma, Project, RightsType } from "@clipforge/database";
import { CREDIT_COSTS } from "@clipforge/shared-types";
import { PrismaService } from "../prisma/prisma.service";
import { QueuesService } from "../queues/queues.service";
import { StorageService } from "../storage/storage.service";
import { UsageService } from "../usage/usage.service";
import {
  CreateProjectDto,
  ImportSourceDto,
  ImportSourceType,
  ListProjectsQueryDto,
  UpdateProjectDto,
} from "./dto/project.dto";

const projectListInclude = {
  source: true,
  _count: { select: { clips: true, highlights: true } },
} satisfies Prisma.ProjectInclude;

type ProjectWithRelations = Prisma.ProjectGetPayload<{
  include: typeof projectListInclude;
}>;

@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueuesService,
    private readonly storage: StorageService,
    private readonly usage: UsageService,
  ) {}

  /** Loads a project and enforces ownership. All access funnels through here. */
  async getOwned(projectId: string, userId: string): Promise<Project> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });
    if (!project) throw new NotFoundException("Project not found");
    if (project.userId !== userId) {
      // Same response as not-found so project IDs can't be probed
      throw new NotFoundException("Project not found");
    }
    return project;
  }

  async create(userId: string, dto: CreateProjectDto) {
    return this.prisma.project.create({
      data: {
        userId,
        name: dto.name?.trim() || "Untitled project",
      },
    });
  }

  async list(userId: string, query: ListProjectsQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 12;
    const [items, total] = await this.prisma.$transaction([
      this.prisma.project.findMany({
        where: { userId },
        orderBy: { updatedAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: projectListInclude,
      }),
      this.prisma.project.count({ where: { userId } }),
    ]);
    return {
      items: await Promise.all(items.map((p) => this.toSummary(p))),
      total,
      page,
      pageSize,
    };
  }

  async detail(projectId: string, userId: string) {
    await this.getOwned(projectId, userId);
    const project = await this.prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      include: {
        source: true,
        highlights: { orderBy: { score: "desc" } },
        clips: { orderBy: { updatedAt: "desc" } },
        transcript: { select: { status: true, language: true } },
        _count: { select: { clips: true, highlights: true } },
      },
    });
    const summary = await this.toSummary(project);
    // Signed URLs for private media the browser needs to show
    let mediaUrl: string | null = null;
    if (project.source?.storageKey) {
      mediaUrl = await this.storage.presignGet(project.source.storageKey);
    }
    return {
      ...summary,
      error: project.error,
      transcript: project.transcript,
      highlights: project.highlights,
      clips: project.clips,
      mediaUrl,
    };
  }

  async update(projectId: string, userId: string, dto: UpdateProjectDto) {
    await this.getOwned(projectId, userId);
    return this.prisma.project.update({
      where: { id: projectId },
      data: { ...(dto.name ? { name: dto.name.trim() } : {}) },
    });
  }

  async remove(projectId: string, userId: string): Promise<void> {
    await this.getOwned(projectId, userId);
    // Collect storage keys before the cascade delete, then clean up async
    const source = await this.prisma.videoSource.findUnique({
      where: { projectId },
    });
    const exportRows = await this.prisma.export.findMany({
      where: { clip: { projectId } },
      select: { storageKey: true },
    });
    const clipRows = await this.prisma.clip.findMany({
      where: { projectId },
      select: { renderedKey: true, previewKey: true },
    });
    const keys = [
      source?.storageKey,
      source?.audioKey,
      source?.thumbnailKey,
      ...exportRows.map((e) => e.storageKey),
      ...clipRows.flatMap((c) => [c.renderedKey, c.previewKey]),
    ].filter((k): k is string => Boolean(k));

    await this.prisma.project.delete({ where: { id: projectId } });
    await this.queues.enqueueCleanup({ storageKeys: keys });
  }

  /**
   * Attaches a source to a project, charges the import credit and hands
   * the heavy lifting (probe/thumbnail/audio-extract or metadata fetch)
   * to the video-import worker.
   */
  async importSource(projectId: string, userId: string, dto: ImportSourceDto) {
    const project = await this.getOwned(projectId, userId);
    if (!["DRAFT", "FAILED"].includes(project.status)) {
      throw new BadRequestException(
        `Project already has a source (status: ${project.status})`,
      );
    }

    let sourceData: Prisma.VideoSourceUncheckedCreateInput;
    let sourceUrl: string | null = null;

    if (dto.sourceType === ImportSourceType.UPLOAD) {
      if (!dto.storageKey) {
        throw new BadRequestException("storageKey is required for uploads");
      }
      // Users may only attach objects inside their own storage prefix
      if (!dto.storageKey.startsWith(`users/${userId}/`)) {
        throw new ForbiddenException("Invalid storage key");
      }
      sourceData = {
        projectId,
        sourceType: "UPLOAD",
        storageKey: dto.storageKey,
        rights: dto.rights as RightsType,
        rightsNote: dto.rightsNote,
      };
    } else {
      if (!dto.url) {
        throw new BadRequestException("url is required for YouTube sources");
      }
      const videoId = extractYouTubeId(dto.url);
      if (!videoId) {
        throw new BadRequestException("Unrecognized YouTube URL");
      }
      sourceUrl = `https://www.youtube.com/watch?v=${videoId}`;
      sourceData = {
        projectId,
        sourceType: "YOUTUBE",
        externalId: videoId,
        rights: dto.rights as RightsType,
        rightsNote: dto.rightsNote,
      };
    }

    await this.usage.spend(userId, CREDIT_COSTS.importVideo, "IMPORT_VIDEO", {
      projectId,
    });

    try {
      const [, updated] = await this.prisma.$transaction([
        this.prisma.videoSource.upsert({
          where: { projectId },
          create: sourceData,
          update: sourceData,
        }),
        this.prisma.project.update({
          where: { id: projectId },
          data: { status: "IMPORTING", sourceUrl, error: null },
        }),
      ]);
      await this.queues.enqueueVideoImport({ projectId, userId });
      return updated;
    } catch (err) {
      await this.usage.refund(userId, CREDIT_COSTS.importVideo, { projectId });
      this.logger.error(`Import setup failed for project ${projectId}`, err);
      throw err;
    }
  }

  async getSource(projectId: string, userId: string) {
    await this.getOwned(projectId, userId);
    const source = await this.prisma.videoSource.findUnique({
      where: { projectId },
    });
    if (!source) throw new NotFoundException("No source imported yet");
    return {
      ...serializeSource(source),
      mediaUrl: source.storageKey
        ? await this.storage.presignGet(source.storageKey)
        : null,
    };
  }

  private async toSummary(project: ProjectWithRelations) {
    let thumbnailUrl = project.source?.thumbnailUrl ?? null;
    if (!thumbnailUrl && project.source?.thumbnailKey) {
      thumbnailUrl = await this.storage.presignGet(project.source.thumbnailKey);
    }
    return {
      id: project.id,
      name: project.name,
      status: project.status,
      sourceUrl: project.sourceUrl,
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
      source: project.source
        ? { ...serializeSource(project.source), thumbnailUrl }
        : null,
      clipCount: project._count.clips,
      highlightCount: project._count.highlights,
    };
  }
}

function serializeSource(source: {
  id: string;
  sourceType: string;
  title: string | null;
  thumbnailUrl: string | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  rights: string;
  sizeBytes: bigint | null;
}) {
  return {
    id: source.id,
    sourceType: source.sourceType,
    title: source.title,
    thumbnailUrl: source.thumbnailUrl,
    duration: source.duration,
    width: source.width,
    height: source.height,
    rights: source.rights,
    sizeBytes:
      source.sizeBytes === null ? null : Number(source.sizeBytes),
  };
}

export function extractYouTubeId(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "youtu.be") {
      const id = u.pathname.slice(1).split("/")[0];
      return isValidYouTubeId(id) ? (id ?? null) : null;
    }
    if (host === "youtube.com" || host === "m.youtube.com") {
      if (u.pathname === "/watch") {
        const id = u.searchParams.get("v");
        return id && isValidYouTubeId(id) ? id : null;
      }
      const shortsMatch = u.pathname.match(/^\/(shorts|live|embed)\/([^/]+)/);
      const id = shortsMatch?.[2];
      if (id && isValidYouTubeId(id)) return id;
    }
    return null;
  } catch {
    return null;
  }
}

function isValidYouTubeId(id: string | undefined): boolean {
  return !!id && /^[A-Za-z0-9_-]{6,20}$/.test(id);
}
