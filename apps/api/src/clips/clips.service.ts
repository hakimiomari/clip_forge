import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Prisma } from "@clipforge/database";
import {
  EDITING_PLAN_VERSION,
  renderCost,
  type CaptionStyleName,
  type DownloadLink,
  type EditingPlan,
  type VideoFormat,
} from "@clipforge/shared-types";
import { hasProcessableMedia } from "../common/media-source";
import { PrismaService } from "../prisma/prisma.service";
import { QueuesService } from "../queues/queues.service";
import { StorageService } from "../storage/storage.service";
import { UsageService } from "../usage/usage.service";
import { HighlightsService } from "../highlights/highlights.service";
import { CreateClipDto, UpdateClipDto } from "./dto/clips.dto";
import { validateRangeEffects } from "./effects.validation";

const RESOLUTIONS: Record<VideoFormat, string> = {
  vertical: "1080x1920",
  square: "1080x1080",
  landscape: "1920x1080",
};

const MIN_CLIP_SECONDS = 5;
const MAX_CLIP_SECONDS = 240;

@Injectable()
export class ClipsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueuesService,
    private readonly storage: StorageService,
    private readonly usage: UsageService,
    private readonly highlights: HighlightsService,
  ) {}

  /** Loads a clip and enforces ownership through its project. */
  async getOwned(clipId: string, userId: string) {
    const clip = await this.prisma.clip.findUnique({
      where: { id: clipId },
      include: { project: { select: { id: true, userId: true } } },
    });
    if (!clip || clip.project.userId !== userId) {
      throw new NotFoundException("Clip not found");
    }
    return clip;
  }

  /**
   * Editing Plan Agent (deterministic v1): builds the plan from a
   * highlight + user options, copies transcript captions into the clip,
   * charges credits and queues the render.
   */
  async createFromHighlight(
    highlightId: string,
    userId: string,
    dto: CreateClipDto,
  ) {
    const highlight = await this.highlights.getOwned(highlightId, userId);
    const projectId = highlight.project.id;
    const source = await this.prisma.videoSource.findUnique({
      where: { projectId },
    });
    if (!source?.duration || !hasProcessableMedia(source)) {
      throw new BadRequestException("Source media is missing for this project");
    }

    const start = clampTime(
      highlight.startTime + (dto.trimStartDelta ?? 0),
      0,
      source.duration - MIN_CLIP_SECONDS,
    );
    const end = clampTime(
      highlight.endTime + (dto.trimEndDelta ?? 0),
      start + MIN_CLIP_SECONDS,
      source.duration,
    );
    const duration = end - start;
    if (duration > MAX_CLIP_SECONDS) {
      throw new BadRequestException(
        `Clips are limited to ${MAX_CLIP_SECONDS} seconds`,
      );
    }

    const plan = buildEditingPlan({
      start,
      end,
      format: dto.format,
      captionsEnabled: dto.captionsEnabled,
      captionStyle: dto.captionStyle,
      zoomEnabled: dto.zoomEnabled,
      backgroundMode: dto.backgroundMode ?? "blur",
    });

    const clip = await this.prisma.clip.create({
      data: {
        projectId,
        highlightId,
        name: dto.name?.trim() || highlight.title || "Clip",
        status: "DRAFT",
        format: dto.format,
        resolution: plan.resolution,
        template: "auto_v1",
        duration,
        editingPlan: plan as unknown as Prisma.InputJsonValue,
        planVersion: EDITING_PLAN_VERSION,
      },
    });
    await this.syncCaptionsFromTranscript(clip.id, projectId, start, end);
    return this.render(clip.id, userId);
  }

  /** Copies transcript segments overlapping the window as clip captions. */
  private async syncCaptionsFromTranscript(
    clipId: string,
    projectId: string,
    start: number,
    end: number,
  ): Promise<void> {
    await this.prisma.caption.deleteMany({ where: { clipId } });
    const transcript = await this.prisma.transcript.findUnique({
      where: { projectId },
      include: {
        segments: {
          where: { startTime: { lt: end }, endTime: { gt: start } },
          orderBy: { index: "asc" },
        },
      },
    });
    if (!transcript || transcript.segments.length === 0) return;
    await this.prisma.caption.createMany({
      data: transcript.segments.map((s, index) => ({
        clipId,
        index,
        startTime: Math.max(0, s.startTime - start),
        endTime: Math.min(end - start, s.endTime - start),
        text: s.text,
        speaker: s.speaker,
      })),
    });
  }

  /** Charges credits and queues a render of the clip's current plan. */
  async render(clipId: string, userId: string) {
    const clip = await this.getOwned(clipId, userId);
    if (["RENDER_QUEUED", "RENDERING"].includes(clip.status)) {
      throw new BadRequestException("This clip is already rendering");
    }
    const plan = clip.editingPlan as unknown as EditingPlan | null;
    const segment = plan?.segments?.[0];
    if (!plan || !segment) {
      throw new BadRequestException("Clip has no editing plan");
    }
    const duration = segment.sourceEnd - segment.sourceStart;
    const cost = renderCost(duration);

    await this.usage.spend(userId, cost, "RENDER_CLIP", {
      projectId: clip.projectId,
      clipId,
    });
    try {
      const renderJob = await this.prisma.renderJob.create({
        data: { clipId, status: "PENDING", step: "Queued" },
      });
      await this.prisma.clip.update({
        where: { id: clipId },
        data: { status: "RENDER_QUEUED" },
      });
      await this.queues.enqueueRenderVideo({
        clipId,
        renderJobId: renderJob.id,
        userId,
        chargedCredits: cost,
      });
      return this.detail(clipId, userId);
    } catch (err) {
      await this.usage.refund(userId, cost, { projectId: clip.projectId, clipId });
      throw err;
    }
  }

  async detail(clipId: string, userId: string) {
    const clip = await this.getOwned(clipId, userId);
    const [renderJob, latestExport] = await Promise.all([
      this.prisma.renderJob.findFirst({
        where: { clipId },
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.export.findFirst({
        where: { clipId },
        orderBy: { createdAt: "desc" },
      }),
    ]);
    const previewUrl = clip.renderedKey
      ? await this.storage.presignGet(clip.renderedKey)
      : null;
    return {
      id: clip.id,
      projectId: clip.projectId,
      highlightId: clip.highlightId,
      name: clip.name,
      status: clip.status,
      format: clip.format,
      resolution: clip.resolution,
      duration: clip.duration,
      editingPlan: clip.editingPlan,
      createdAt: clip.createdAt.toISOString(),
      updatedAt: clip.updatedAt.toISOString(),
      renderJob: renderJob
        ? {
            id: renderJob.id,
            status: renderJob.status,
            progress: renderJob.progress,
            step: renderJob.step,
            error: renderJob.error,
          }
        : null,
      hasExport: Boolean(latestExport),
      previewUrl,
    };
  }

  /** Form-based editing: updates the plan; the user re-renders after. */
  async update(clipId: string, userId: string, dto: UpdateClipDto) {
    const clip = await this.getOwned(clipId, userId);
    if (["RENDER_QUEUED", "RENDERING"].includes(clip.status)) {
      throw new BadRequestException("Wait for the current render to finish");
    }
    const plan = clip.editingPlan as unknown as EditingPlan | null;
    const segment = plan?.segments?.[0];
    if (!plan || !segment) {
      throw new BadRequestException("Clip has no editing plan");
    }
    const source = await this.prisma.videoSource.findUnique({
      where: { projectId: clip.projectId },
    });
    if (!source?.duration) throw new BadRequestException("Source missing");

    const start = clampTime(
      dto.sourceStart ?? segment.sourceStart,
      0,
      source.duration - MIN_CLIP_SECONDS,
    );
    const end = clampTime(
      dto.sourceEnd ?? segment.sourceEnd,
      start + MIN_CLIP_SECONDS,
      source.duration,
    );
    if (end - start > MAX_CLIP_SECONDS) {
      throw new BadRequestException(`Clips are limited to ${MAX_CLIP_SECONDS} seconds`);
    }

    const format = (dto.format ?? plan.format) as VideoFormat;
    const existingBackgroundMode =
      plan.background?.type === "crop_fill"
        ? "fill"
        : plan.background?.type === "blurred_original"
          ? "blur"
          : "black";
    const newPlan = buildEditingPlan({
      start,
      end,
      format,
      captionsEnabled: dto.captionsEnabled ?? plan.captions.enabled,
      captionStyle: (dto.captionStyle ?? plan.captions.style) as CaptionStyleName,
      zoomEnabled:
        dto.zoomEnabled ?? segment.effects.some((e) => e.type === "zoom_in"),
      backgroundMode: dto.backgroundMode ?? existingBackgroundMode,
    });

    const trimChanged =
      start !== segment.sourceStart || end !== segment.sourceEnd;

    // Preserve advanced effects across plan rebuilds. If the trim window
    // moved, shift effect times so they stay anchored to the same source
    // moments; drop any that fall outside the new window.
    const shift = segment.sourceStart - start;
    const newDuration = end - start;
    newPlan.rangeEffects = (plan.rangeEffects ?? [])
      .map((e) => {
        if (e.type === "glow_trail") {
          const keyframes = e.keyframes
            .map((k) => ({ ...k, t: k.t + shift }))
            .filter((k) => k.t >= 0 && k.t <= newDuration);
          return keyframes.length >= 2 ? { ...e, keyframes } : null;
        }
        const start2 = (e as { start: number }).start + shift;
        const end2 = "end" in e ? (e as { end: number }).end + shift : start2;
        if (end2 < 0 || start2 > newDuration) return null;
        return {
          ...e,
          start: Math.max(0, start2),
          ...("end" in e ? { end: Math.min(newDuration, end2) } : {}),
        } as typeof e;
      })
      .filter((e): e is NonNullable<typeof e> => e !== null);

    const updated = await this.prisma.clip.update({
      where: { id: clipId },
      data: {
        name: dto.name?.trim() || clip.name,
        status: "EDITING",
        format,
        resolution: newPlan.resolution,
        duration: end - start,
        editingPlan: newPlan as unknown as Prisma.InputJsonValue,
      },
    });
    if (trimChanged) {
      await this.syncCaptionsFromTranscript(clipId, clip.projectId, start, end);
    }
    return updated;
  }

  /** Replaces the clip's advanced range effects (validated server-side). */
  async updateEffects(clipId: string, userId: string, effects: unknown) {
    const clip = await this.getOwned(clipId, userId);
    if (["RENDER_QUEUED", "RENDERING"].includes(clip.status)) {
      throw new BadRequestException("Wait for the current render to finish");
    }
    const plan = clip.editingPlan as unknown as EditingPlan | null;
    const segment = plan?.segments?.[0];
    if (!plan || !segment) {
      throw new BadRequestException("Clip has no editing plan");
    }
    const clipDuration = segment.sourceEnd - segment.sourceStart;
    const validated = validateRangeEffects(effects, clipDuration);
    const newPlan: EditingPlan = { ...plan, rangeEffects: validated };
    await this.prisma.clip.update({
      where: { id: clipId },
      data: {
        status: clip.status === "RENDERED" ? "EDITING" : clip.status,
        editingPlan: newPlan as unknown as Prisma.InputJsonValue,
      },
    });
    return { ok: true, effects: validated };
  }

  async download(clipId: string, userId: string): Promise<DownloadLink> {
    await this.getOwned(clipId, userId);
    const latest = await this.prisma.export.findFirst({
      where: { clipId },
      orderBy: { createdAt: "desc" },
    });
    if (!latest) {
      throw new NotFoundException(
        "No rendered export yet — render the clip first",
      );
    }
    const downloadUrl = await this.storage.presignGet(latest.storageKey, {
      expiresIn: 3600,
      downloadFileName: latest.fileName,
    });
    return {
      status: "completed",
      fileName: latest.fileName,
      downloadUrl,
      expiresIn: 3600,
    };
  }

  async listExports(projectId: string, userId: string) {
    // Ownership via project
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { userId: true },
    });
    if (!project || project.userId !== userId) {
      throw new NotFoundException("Project not found");
    }
    const exports = await this.prisma.export.findMany({
      where: { clip: { projectId } },
      orderBy: { createdAt: "desc" },
      include: { clip: { select: { name: true } } },
    });
    return exports.map((e) => ({
      id: e.id,
      clipId: e.clipId,
      clipName: e.clip.name,
      fileName: e.fileName,
      format: e.format,
      resolution: e.resolution,
      sizeBytes: e.sizeBytes === null ? null : Number(e.sizeBytes),
      createdAt: e.createdAt.toISOString(),
    }));
  }

  async remove(clipId: string, userId: string): Promise<void> {
    const clip = await this.getOwned(clipId, userId);
    const exports = await this.prisma.export.findMany({
      where: { clipId },
      select: { storageKey: true },
    });
    const keys = [
      clip.renderedKey,
      clip.previewKey,
      ...exports.map((e) => e.storageKey),
    ].filter((k): k is string => Boolean(k));
    await this.prisma.clip.delete({ where: { id: clipId } });
    await this.queues.enqueueCleanup({ storageKeys: keys });
  }
}

function clampTime(x: number, min: number, max: number): number {
  return Math.round(Math.max(min, Math.min(max, x)) * 10) / 10;
}

function buildEditingPlan(opts: {
  start: number;
  end: number;
  format: VideoFormat;
  captionsEnabled: boolean;
  captionStyle: CaptionStyleName | string;
  zoomEnabled: boolean;
  backgroundMode?: "blur" | "fill" | "black" | string;
}): EditingPlan {
  const duration = opts.end - opts.start;
  const background: EditingPlan["background"] =
    opts.backgroundMode === "fill"
      ? { type: "crop_fill" }
      : opts.backgroundMode === "black"
        ? undefined
        : { type: "blurred_original", blurIntensity: 55 };
  return {
    version: EDITING_PLAN_VERSION,
    duration,
    format: opts.format,
    resolution: RESOLUTIONS[opts.format],
    template: "auto_v1",
    segments: [
      {
        sourceStart: opts.start,
        sourceEnd: opts.end,
        crop: { mode: "center" },
        effects: opts.zoomEnabled
          ? [{ type: "zoom_in", start: 0, duration, intensity: 1.08 }]
          : [],
      },
    ],
    captions: {
      enabled: opts.captionsEnabled,
      style: opts.captionStyle as CaptionStyleName,
      position: "center",
      highlightKeywords: false,
      animation: "sentence",
    },
    transitions: [],
    audio: {
      originalVolume: 1,
      backgroundMusic: false,
      musicVolume: 0,
      fadeIn: true,
      fadeOut: true,
      normalize: true,
    },
    background,
  };
}
