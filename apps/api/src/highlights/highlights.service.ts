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
