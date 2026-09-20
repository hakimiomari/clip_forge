import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { CREDIT_COSTS } from "@clipforge/shared-types";
import { hasProcessableMedia } from "../common/media-source";
import { PrismaService } from "../prisma/prisma.service";
import { ProjectsService } from "../projects/projects.service";
import { QueuesService } from "../queues/queues.service";
import { UsageService } from "../usage/usage.service";
import { GenerateHighlightsDto } from "./dto/highlights.dto";

const BUSY_STATUSES = ["IMPORTING", "ANALYZING", "GENERATING_HIGHLIGHTS"];

@Injectable()
export class HighlightsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
    private readonly queues: QueuesService,
    private readonly usage: UsageService,
  ) {}

  async generate(projectId: string, userId: string, dto: GenerateHighlightsDto) {
    const project = await this.projects.getOwned(projectId, userId);
    if (BUSY_STATUSES.includes(project.status)) {
      throw new BadRequestException(
        "This project is already being processed — wait for it to finish.",
      );
    }
    const source = await this.prisma.videoSource.findUnique({
      where: { projectId },
    });
    if (!source?.duration || !hasProcessableMedia(source)) {
      throw new BadRequestException(
        "Import a video before generating highlights.",
      );
    }
    if (dto.clipDuration >= source.duration) {
      throw new BadRequestException(
        `Clip duration (${dto.clipDuration}s) must be shorter than the video (${Math.floor(source.duration)}s).`,
      );
    }

    await this.usage.spend(
      userId,
      CREDIT_COSTS.generateHighlights,
      "GENERATE_HIGHLIGHTS",
      { projectId },
    );
    try {
      await this.prisma.project.update({
        where: { id: projectId },
        data: { status: "ANALYZING", error: null },
      });
      await this.queues.enqueueHighlightGeneration({
        projectId,
        userId,
        options: {
          clipDuration: dto.clipDuration,
          clipCount: dto.clipCount,
          format: dto.format,
          editingStyle: dto.editingStyle,
          captionStyle: dto.captionStyle,
          useTranscript: dto.useTranscript,
        },
      });
      return { ok: true, status: "ANALYZING" };
    } catch (err) {
      await this.usage.refund(userId, CREDIT_COSTS.generateHighlights, {
        projectId,
      });
      await this.prisma.project.update({
        where: { id: projectId },
        data: { status: project.status },
      });
      throw err;
    }
  }

  async list(projectId: string, userId: string) {
    await this.projects.getOwned(projectId, userId);
    return this.prisma.highlight.findMany({
      where: { projectId },
      orderBy: { score: "desc" },
    });
  }

  /** Full transcript with segments for the project's transcript panel. */
  async transcript(projectId: string, userId: string) {
    await this.projects.getOwned(projectId, userId);
    const transcript = await this.prisma.transcript.findUnique({
      where: { projectId },
      include: { segments: { orderBy: { index: "asc" } } },
    });
    if (!transcript) {
      return { status: "PENDING", language: null, provider: null, segments: [] };
    }
    return {
      status: transcript.status,
      language: transcript.language,
      provider: transcript.provider,
      error: transcript.error,
      segments: transcript.segments.map((s) => ({
        startTime: s.startTime,
        endTime: s.endTime,
        text: s.text,
        speaker: s.speaker,
      })),
    };
  }

  async getOwned(highlightId: string, userId: string) {
    const highlight = await this.prisma.highlight.findUnique({
      where: { id: highlightId },
      include: { project: { select: { userId: true, id: true } } },
    });
    if (!highlight || highlight.project.userId !== userId) {
      throw new NotFoundException("Highlight not found");
    }
    return highlight;
  }
}
