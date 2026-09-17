import { Controller, Get } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { DashboardStats } from "@clipforge/shared-types";
import { PrismaService } from "../prisma/prisma.service";
import {
  CurrentUser,
  RequestUser,
} from "../common/decorators/current-user.decorator";

@ApiTags("dashboard")
@Controller("dashboard")
export class DashboardController {
  constructor(private readonly prisma: PrismaService) {}

  @Get("stats")
  async stats(@CurrentUser() user: RequestUser): Promise<DashboardStats> {
    const [totalProjects, totalClips, completedExports, processingJobs, me] =
      await this.prisma.$transaction([
        this.prisma.project.count({ where: { userId: user.id } }),
        this.prisma.clip.count({ where: { project: { userId: user.id } } }),
        this.prisma.export.count({
          where: { clip: { project: { userId: user.id } } },
        }),
        this.prisma.project.count({
          where: {
            userId: user.id,
            status: {
              in: [
                "IMPORTING",
                "ANALYZING",
                "GENERATING_HIGHLIGHTS",
                "RENDERING",
              ],
            },
          },
        }),
        this.prisma.user.findUniqueOrThrow({
          where: { id: user.id },
          select: { creditBalance: true },
        }),
      ]);
    return {
      totalProjects,
      totalClips,
      completedExports,
      processingJobs,
      remainingCredits: me.creditBalance,
    };
  }
}
