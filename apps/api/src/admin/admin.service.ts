import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Prisma } from "@clipforge/database";
import { PrismaService } from "../prisma/prisma.service";
import { QueuesService } from "../queues/queues.service";
import {
  AdminAdjustCreditsDto,
  AdminListUsersQueryDto,
  AdminUpdateUserDto,
} from "./dto/admin.dto";

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueuesService,
  ) {}

  async stats() {
    const [
      [
        totalUsers,
        totalProjects,
        totalClips,
        totalExports,
        failedProjects,
        processingProjects,
        creditAggregate,
      ],
      renderJobsByStatus,
    ] = await Promise.all([
      this.prisma.$transaction([
        this.prisma.user.count(),
        this.prisma.project.count(),
        this.prisma.clip.count(),
        this.prisma.export.count(),
        this.prisma.project.count({ where: { status: "FAILED" } }),
        this.prisma.project.count({
          where: {
            status: {
              in: ["IMPORTING", "ANALYZING", "GENERATING_HIGHLIGHTS", "RENDERING"],
            },
          },
        }),
        this.prisma.creditTransaction.aggregate({
          where: { amount: { lt: 0 } },
          _sum: { amount: true },
        }),
      ]),
      this.prisma.renderJob.groupBy({
        by: ["status"],
        _count: true,
        orderBy: { status: "asc" },
      }),
    ]);
    return {
      totalUsers,
      totalProjects,
      totalClips,
      totalExports,
      failedProjects,
      processingProjects,
      renderJobs: Object.fromEntries(
        renderJobsByStatus.map((r) => [r.status, r._count]),
      ),
      creditsSpent: Math.abs(creditAggregate._sum.amount ?? 0),
    };
  }

  async listUsers(query: AdminListUsersQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const where: Prisma.UserWhereInput = query.query
      ? {
          OR: [
            { email: { contains: query.query, mode: "insensitive" } },
            { name: { contains: query.query, mode: "insensitive" } },
          ],
        }
      : {};
    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          plan: true,
          creditBalance: true,
          suspendedAt: true,
          createdAt: true,
          _count: { select: { projects: true } },
        },
      }),
      this.prisma.user.count({ where }),
    ]);
    return {
      items: items.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        plan: u.plan,
        creditBalance: u.creditBalance,
        suspended: Boolean(u.suspendedAt),
        projectCount: u._count.projects,
        createdAt: u.createdAt.toISOString(),
      })),
      total,
      page,
      pageSize,
    };
  }

  async updateUser(adminId: string, userId: string, dto: AdminUpdateUserDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException("User not found");
    if (userId === adminId && (dto.role === "USER" || dto.suspended === true)) {
      throw new BadRequestException(
        "You cannot demote or suspend your own account",
      );
    }
    const data: Prisma.UserUpdateInput = {};
    if (dto.role) data.role = dto.role;
    if (dto.plan) data.plan = dto.plan;
    if (dto.suspended !== undefined) {
      data.suspendedAt = dto.suspended ? new Date() : null;
    }
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data,
    });
    // Suspending revokes active refresh tokens immediately
    if (dto.suspended === true) {
      await this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    return {
      id: updated.id,
      role: updated.role,
      plan: updated.plan,
      suspended: Boolean(updated.suspendedAt),
    };
  }

  async adjustCredits(userId: string, dto: AdminAdjustCreditsDto) {
    if (dto.amount === 0) throw new BadRequestException("Amount cannot be 0");
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException("User not found");
    if (dto.amount < 0 && user.creditBalance + dto.amount < 0) {
      throw new BadRequestException(
        `Cannot remove ${-dto.amount} credits — balance is ${user.creditBalance}`,
      );
    }
    const [updated] = await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { creditBalance: { increment: dto.amount } },
      }),
      this.prisma.creditTransaction.create({
        data: { userId, amount: dto.amount, reason: "ADMIN_ADJUSTMENT" },
      }),
    ]);
    return { id: updated.id, creditBalance: updated.creditBalance };
  }

  async listJobs() {
    const [failedRenders, recentRenders, failedProjects] =
      await this.prisma.$transaction([
        this.prisma.renderJob.findMany({
          where: { status: "FAILED" },
          orderBy: { createdAt: "desc" },
          take: 25,
          include: {
            clip: {
              select: {
                id: true,
                name: true,
                projectId: true,
                project: { select: { name: true, userId: true } },
              },
            },
          },
        }),
        this.prisma.renderJob.findMany({
          orderBy: { createdAt: "desc" },
          take: 15,
          include: { clip: { select: { id: true, name: true } } },
        }),
        this.prisma.project.findMany({
          where: { status: "FAILED" },
          orderBy: { updatedAt: "desc" },
          take: 25,
          select: {
            id: true,
            name: true,
            error: true,
            userId: true,
            updatedAt: true,
          },
        }),
      ]);
    return {
      failedRenders: failedRenders.map(serializeRenderJob),
      recentRenders: recentRenders.map(serializeRenderJob),
      failedProjects: failedProjects.map((p) => ({
        ...p,
        updatedAt: p.updatedAt.toISOString(),
      })),
    };
  }

  /** Re-queues a failed render without charging the user again. */
  async retryRenderJob(renderJobId: string) {
    const failed = await this.prisma.renderJob.findUnique({
      where: { id: renderJobId },
      include: { clip: { include: { project: { select: { userId: true } } } } },
    });
    if (!failed) throw new NotFoundException("Render job not found");
    if (failed.status !== "FAILED") {
      throw new BadRequestException("Only failed jobs can be retried");
    }
    const renderJob = await this.prisma.renderJob.create({
      data: { clipId: failed.clipId, status: "PENDING", step: "Queued (admin retry)" },
    });
    await this.prisma.clip.update({
      where: { id: failed.clipId },
      data: { status: "RENDER_QUEUED" },
    });
    await this.queues.enqueueRenderVideo({
      clipId: failed.clipId,
      renderJobId: renderJob.id,
      userId: failed.clip.project.userId,
      chargedCredits: 0, // admin retry: nothing to refund on failure
    });
    return { ok: true, renderJobId: renderJob.id };
  }

  /** Admin content moderation: delete any project and its files. */
  async deleteProject(projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: { source: true },
    });
    if (!project) throw new NotFoundException("Project not found");
    const exports = await this.prisma.export.findMany({
      where: { clip: { projectId } },
      select: { storageKey: true },
    });
    const clips = await this.prisma.clip.findMany({
      where: { projectId },
      select: { renderedKey: true, previewKey: true },
    });
    const keys = [
      project.source?.storageKey,
      project.source?.audioKey,
      project.source?.thumbnailKey,
      ...exports.map((e) => e.storageKey),
      ...clips.flatMap((c) => [c.renderedKey, c.previewKey]),
    ].filter((k): k is string => Boolean(k));
    await this.prisma.project.delete({ where: { id: projectId } });
    await this.queues.enqueueCleanup({ storageKeys: keys });
  }
}

function serializeRenderJob(job: {
  id: string;
  status: string;
  progress: number;
  step: string | null;
  error: string | null;
  createdAt: Date;
  clip: { id: string; name: string | null } & Record<string, unknown>;
}) {
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    step: job.step,
    error: job.error,
    createdAt: job.createdAt.toISOString(),
    clip: job.clip,
  };
}
