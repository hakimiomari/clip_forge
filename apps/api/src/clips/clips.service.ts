import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Prisma } from "@clipforge/database";
import {
  buildEditingPlan,
  CLIP_RESOLUTIONS,
  EDITING_PLAN_VERSION,
  planTotalDuration,
  renderCost,
  type CaptionStyleName,
  type ClipPart,
  type DownloadLink,
  type EditingPlan,
  type PlanCartoon,
  type VideoFormat,
} from "@clipforge/shared-types";
import { hasProcessableMedia } from "../common/media-source";
import { PrismaService } from "../prisma/prisma.service";
import { QueuesService } from "../queues/queues.service";
import { StorageService } from "../storage/storage.service";
import { UsageService } from "../usage/usage.service";
import { HighlightsService } from "../highlights/highlights.service";
import { ProjectsService } from "../projects/projects.service";
import {
  CartoonDto,
  CreateClipDto,
  CreateClipFromRangeDto,
  UpdateClipDto,
} from "./dto/clips.dto";
import { validateRangeEffects } from "./effects.validation";

const MIN_CLIP_SECONDS = 5;
const MAX_CLIP_SECONDS = 240;
/** A single part of a stitched clip can be brief — the total still must reach MIN_CLIP_SECONDS. */
const MIN_PART_SECONDS = 0.5;
/** Rounding slack allowed when a selection ends on the final frame. */
const END_TOLERANCE_SECONDS = 0.5;

@Injectable()
export class ClipsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueuesService,
    private readonly storage: StorageService,
    private readonly usage: UsageService,
    private readonly highlights: HighlightsService,
    private readonly projects: ProjectsService,
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

    return this.createClipForRange({
      projectId,
      userId,
      parts: [{ start, end }],
      dto,
      highlightId,
      fallbackName: highlight.title,
    });
  }

  /**
   * Creates a clip from a range the user picked on the timeline —
   * the same pipeline as an AI highlight, without the suggestion.
   */
  async createFromRange(
    projectId: string,
    userId: string,
    dto: CreateClipFromRangeDto,
  ) {
    await this.projects.getOwned(projectId, userId);
    const source = await this.prisma.videoSource.findUnique({
      where: { projectId },
    });
    if (!source?.duration || !hasProcessableMedia(source)) {
      throw new BadRequestException("Source media is missing for this project");
    }
    // One range or several parts stitched in order
    const requestedParts =
      dto.segments && dto.segments.length > 0
        ? dto.segments.map((s) => ({ start: s.sourceStart, end: s.sourceEnd }))
        : dto.sourceStart !== undefined && dto.sourceEnd !== undefined
          ? [{ start: dto.sourceStart, end: dto.sourceEnd }]
          : null;
    if (!requestedParts) {
      throw new BadRequestException(
        "Provide sourceStart and sourceEnd, or a segments array",
      );
    }

    const parts = requestedParts.map((part, index) => {
      const label = requestedParts.length > 1 ? `Part ${index + 1}` : "The clip";
      if (part.end <= part.start) {
        throw new BadRequestException(`${label} must end after it starts`);
      }
      if (part.start >= source.duration!) {
        throw new BadRequestException(
          `${label} starts past the end of the video`,
        );
      }
      // Tolerate a rounding overshoot at the very end, but refuse a range
      // that genuinely runs past the video rather than quietly shrinking it
      if (part.end > source.duration! + END_TOLERANCE_SECONDS) {
        throw new BadRequestException(
          `${label} ends at ${part.end.toFixed(1)}s but the video is only ` +
            `${source.duration!.toFixed(1)}s long`,
        );
      }
      // Use the range as given rather than silently widening it — this is
      // the user's explicit selection, not a suggestion to adjust
      const start = clampTime(part.start, 0, source.duration!);
      const end = clampTime(part.end, start, source.duration!);
      if (end - start < MIN_PART_SECONDS) {
        throw new BadRequestException(
          `${label} is too short — each part must be at least ${MIN_PART_SECONDS} seconds`,
        );
      }
      return { start, end };
    });

    const total = parts.reduce((sum, p) => sum + (p.end - p.start), 0);
    if (total < MIN_CLIP_SECONDS) {
      throw new BadRequestException(
        `Select at least ${MIN_CLIP_SECONDS} seconds of video in total`,
      );
    }
    if (total > MAX_CLIP_SECONDS) {
      throw new BadRequestException(
        `Clips are limited to ${MAX_CLIP_SECONDS} seconds (selected ${total.toFixed(1)}s)`,
      );
    }

    return this.createClipForRange({ projectId, userId, parts, dto });
  }

  /** Shared tail of clip creation: plan → row → captions → render. */
  private async createClipForRange(args: {
    projectId: string;
    userId: string;
    parts: ClipPart[];
    dto: CreateClipDto;
    highlightId?: string;
    fallbackName?: string | null;
  }) {
    const { projectId, userId, parts, dto, highlightId, fallbackName } = args;
    const duration = parts.reduce((sum, p) => sum + (p.end - p.start), 0);
    if (duration > MAX_CLIP_SECONDS) {
      throw new BadRequestException(
        `Clips are limited to ${MAX_CLIP_SECONDS} seconds`,
      );
    }

    const plan = buildEditingPlan({
      parts,
      format: dto.format,
      captionsEnabled: dto.captionsEnabled,
      captionStyle: dto.captionStyle,
      zoomEnabled: dto.zoomEnabled,
      backgroundMode: dto.backgroundMode ?? "blur",
      ctaEnabled: dto.ctaEnabled ?? true,
      cartoon: normalizeCartoon(dto.cartoon),
    });

    const clip = await this.prisma.clip.create({
      data: {
        projectId,
        highlightId,
        name: dto.name?.trim() || fallbackName || "Clip",
        status: "DRAFT",
        format: dto.format,
        resolution: plan.resolution,
        template: "auto_v1",
        duration,
        editingPlan: plan as unknown as Prisma.InputJsonValue,
        planVersion: EDITING_PLAN_VERSION,
      },
    });
    await this.syncCaptionsFromTranscript(clip.id, projectId, parts);
    return this.render(clip.id, userId);
  }

  /**
   * Copies transcript text overlapping each part, shifted onto the
   * stitched clip's timeline: part 2's captions start after part 1 ends,
   * not at their original source time.
   */
  private async syncCaptionsFromTranscript(
    clipId: string,
    projectId: string,
    parts: ClipPart[],
  ): Promise<void> {
    await this.prisma.caption.deleteMany({ where: { clipId } });
    const transcript = await this.prisma.transcript.findUnique({
      where: { projectId },
      include: {
        segments: {
          where: {
            OR: parts.map((p) => ({
              startTime: { lt: p.end },
              endTime: { gt: p.start },
            })),
          },
          orderBy: { index: "asc" },
        },
      },
    });
    if (!transcript || transcript.segments.length === 0) return;

    const rows: Prisma.CaptionCreateManyInput[] = [];
    let offset = 0;
    for (const part of parts) {
      const partLength = part.end - part.start;
      for (const s of transcript.segments) {
        if (s.startTime >= part.end || s.endTime <= part.start) continue;
        rows.push({
          clipId,
          index: rows.length,
          startTime: Math.max(0, s.startTime - part.start) + offset,
          endTime: Math.min(partLength, s.endTime - part.start) + offset,
          text: s.text,
          speaker: s.speaker,
        });
      }
      offset += partLength;
    }
    if (rows.length > 0) {
      await this.prisma.caption.createMany({ data: rows });
    }
  }

  /** Charges credits and queues a render of the clip's current plan. */
  async render(clipId: string, userId: string) {
    const clip = await this.getOwned(clipId, userId);
    if (["RENDER_QUEUED", "RENDERING"].includes(clip.status)) {
      throw new BadRequestException("This clip is already rendering");
    }
    const plan = clip.editingPlan as unknown as EditingPlan | null;
    if (!plan?.segments?.length) {
      throw new BadRequestException("Clip has no editing plan");
    }
    // Stitched clips are billed on their total length, not the first part
    const duration = planTotalDuration(plan);
    const cost = renderCost(duration);

    // A clip created before the transcript existed has no caption rows, so
    // re-rendering it would silently drop captions again. Pick them up now
    // that they exist — only when empty, so nothing already set is lost.
    if (plan.captions.enabled) {
      const existingCaptions = await this.prisma.caption.count({ where: { clipId } });
      if (existingCaptions === 0) {
        await this.syncCaptionsFromTranscript(
          clipId,
          clip.projectId,
          plan.segments.map((s) => ({ start: s.sourceStart, end: s.sourceEnd })),
        );
      }
    }

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

    const existingParts: ClipPart[] = plan.segments.map((s) => ({
      start: s.sourceStart,
      end: s.sourceEnd,
    }));
    const wantsTrim = dto.sourceStart !== undefined || dto.sourceEnd !== undefined;
    if (wantsTrim && existingParts.length > 1) {
      throw new BadRequestException(
        "This clip is stitched from several parts — trimming one range would be ambiguous. " +
          "Create a new clip from the timeline to change its parts.",
      );
    }

    let parts = existingParts;
    if (existingParts.length === 1) {
      const current = existingParts[0]!;
      const start = clampTime(
        dto.sourceStart ?? current.start,
        0,
        source.duration - MIN_CLIP_SECONDS,
      );
      const end = clampTime(
        dto.sourceEnd ?? current.end,
        start + MIN_CLIP_SECONDS,
        source.duration,
      );
      if (end - start > MAX_CLIP_SECONDS) {
        throw new BadRequestException(`Clips are limited to ${MAX_CLIP_SECONDS} seconds`);
      }
      parts = [{ start, end }];
    }

    const format = (dto.format ?? plan.format) as VideoFormat;
    const existingBackgroundMode =
      plan.background?.type === "crop_fill"
        ? "fill"
        : plan.background?.type === "blurred_original"
          ? "blur"
          : "black";
    const newPlan = buildEditingPlan({
      parts,
      format,
      captionsEnabled: dto.captionsEnabled ?? plan.captions.enabled,
      captionStyle: (dto.captionStyle ?? plan.captions.style) as CaptionStyleName,
      zoomEnabled:
        dto.zoomEnabled ?? segment.effects.some((e) => e.type === "zoom_in"),
      backgroundMode: dto.backgroundMode ?? existingBackgroundMode,
    });

    const trimChanged = parts.some(
      (p, i) =>
        p.start !== existingParts[i]?.start || p.end !== existingParts[i]?.end,
    );

    // AI background removal (edit-time): preserve + apply overrides
    const mergedBgRemoval = {
      enabled: false,
      replace: "blur" as const,
      ...plan.backgroundRemoval,
      ...(dto.backgroundRemoval
        ? Object.fromEntries(
            Object.entries(dto.backgroundRemoval).filter(([, v]) => v !== undefined),
          )
        : {}),
    };
    if (mergedBgRemoval.color) {
      mergedBgRemoval.color = mergedBgRemoval.color.replace(/[^0-9a-fA-F]/g, "").slice(0, 6);
    }
    if (
      mergedBgRemoval.enabled &&
      (newPlan.rangeEffects ?? plan.rangeEffects ?? []).some((e) =>
        ["slow_motion", "speed_up", "freeze_frame", "speed_ramp"].includes(e.type),
      )
    ) {
      throw new BadRequestException(
        "AI background removal cannot be combined with speed effects — remove them first",
      );
    }
    newPlan.backgroundRemoval = mergedBgRemoval;

    // Cartoon stylization (edit-time): preserve + apply overrides
    const mergedCartoon: PlanCartoon = {
      enabled: false,
      style: "hayao",
      fps: 12,
      quality: "high",
      ...plan.cartoon,
      ...(dto.cartoon
        ? Object.fromEntries(
            Object.entries(dto.cartoon).filter(([, v]) => v !== undefined),
          )
        : {}),
    };
    if (mergedCartoon.enabled && mergedBgRemoval.enabled) {
      throw new BadRequestException(
        "Cartoon style and AI background removal both redraw the footage — turn one off",
      );
    }
    newPlan.cartoon = mergedCartoon.enabled ? mergedCartoon : undefined;

    // Preserve existing CTA settings, then layer the new ones on top
    newPlan.cta = {
      ...(newPlan.cta as NonNullable<EditingPlan["cta"]>),
      ...plan.cta,
      ...(dto.cta
        ? Object.fromEntries(
            Object.entries(dto.cta).filter(([, v]) => v !== undefined),
          )
        : {}),
    };

    // Preserve existing audio settings, then layer the new ones on top
    newPlan.audio = {
      ...newPlan.audio,
      ...plan.audio,
      ...(dto.audio
        ? {
            ...(dto.audio.volume !== undefined
              ? { originalVolume: dto.audio.volume }
              : {}),
            ...(dto.audio.pitchSemitones !== undefined
              ? { pitchSemitones: dto.audio.pitchSemitones }
              : {}),
            ...(dto.audio.bassGain !== undefined ? { bassGain: dto.audio.bassGain } : {}),
            ...(dto.audio.trebleGain !== undefined
              ? { trebleGain: dto.audio.trebleGain }
              : {}),
            ...(dto.audio.noiseReduction !== undefined
              ? { noiseReduction: dto.audio.noiseReduction }
              : {}),
            ...(dto.audio.voiceEnhance !== undefined
              ? { voiceEnhance: dto.audio.voiceEnhance }
              : {}),
            ...(dto.audio.voiceEffect !== undefined
              ? { voiceEffect: dto.audio.voiceEffect }
              : {}),
            ...(dto.audio.normalize !== undefined ? { normalize: dto.audio.normalize } : {}),
            ...(dto.audio.fadeIn !== undefined ? { fadeIn: dto.audio.fadeIn } : {}),
            ...(dto.audio.fadeOut !== undefined ? { fadeOut: dto.audio.fadeOut } : {}),
          }
        : {}),
    };

    // Preserve advanced effects across plan rebuilds. If the trim window
    // moved, shift effect times so they stay anchored to the same source
    // moments; drop any that fall outside the new window.
    // Multi-part clips can't be trimmed here, so their timeline is
    // unchanged and effects keep their positions (shift stays 0).
    const shift =
      existingParts.length === 1 && parts[0]
        ? existingParts[0]!.start - parts[0].start
        : 0;
    const newDuration = parts.reduce((sum, p) => sum + (p.end - p.start), 0);
    newPlan.rangeEffects = (plan.rangeEffects ?? [])
      .map((e) => {
        if (e.type === "glow_trail") {
          const keyframes = e.keyframes
            .map((k) => ({ ...k, t: k.t + shift }))
            .filter((k) => k.t >= 0 && k.t <= newDuration);
          return keyframes.length >= 2 ? { ...e, keyframes } : null;
        }
        if (e.type === "speed_ramp") {
          const keyframes = e.keyframes
            .map((k) => ({ ...k, t: Math.max(0, Math.min(newDuration, k.t + shift)) }))
            .filter((k, i, arr) => i === 0 || k.t > arr[i - 1]!.t + 0.01);
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
        duration: newDuration,
        editingPlan: newPlan as unknown as Prisma.InputJsonValue,
      },
    });
    if (trimChanged) {
      await this.syncCaptionsFromTranscript(clipId, clip.projectId, parts);
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
    const clipDuration = planTotalDuration(plan);
    const validated = validateRangeEffects(effects, clipDuration);
    if (
      plan.backgroundRemoval?.enabled &&
      validated.some((e) =>
        ["slow_motion", "speed_up", "freeze_frame", "speed_ramp"].includes(e.type),
      )
    ) {
      throw new BadRequestException(
        "Speed effects cannot be combined with AI background removal — disable it first",
      );
    }
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

/** Fills in cartoon defaults; `undefined` leaves the footage untouched. */
function normalizeCartoon(
  cartoon: CartoonDto | undefined,
): PlanCartoon | undefined {
  if (!cartoon?.enabled) return undefined;
  return {
    enabled: true,
    style: cartoon.style ?? "hayao",
    fps: cartoon.fps ?? 12,
    quality: cartoon.quality ?? "high",
  };
}
