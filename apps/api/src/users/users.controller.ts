import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Patch,
  Post,
  Query,
  UnauthorizedException,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import * as bcrypt from "bcryptjs";
import { PrismaService } from "../prisma/prisma.service";
import {
  ChangePasswordDto,
  CreditHistoryQueryDto,
  UpdateProfileDto,
} from "./dto/users.dto";
import {
  CurrentUser,
  RequestUser,
} from "../common/decorators/current-user.decorator";

@ApiTags("users")
@Controller("users")
export class UsersController {
  constructor(private readonly prisma: PrismaService) {}

  @Patch("me")
  async updateProfile(
    @CurrentUser() user: RequestUser,
    @Body() dto: UpdateProfileDto,
  ) {
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: { ...(dto.name !== undefined ? { name: dto.name.trim() || null } : {}) },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        plan: true,
        creditBalance: true,
      },
    });
    return { user: updated };
  }

  @Post("me/password")
  @HttpCode(200)
  async changePassword(
    @CurrentUser() user: RequestUser,
    @Body() dto: ChangePasswordDto,
  ) {
    const record = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { passwordHash: true },
    });
    if (!record.passwordHash) {
      throw new BadRequestException("This account has no password set");
    }
    const valid = await bcrypt.compare(dto.currentPassword, record.passwordHash);
    if (!valid) throw new UnauthorizedException("Current password is incorrect");
    if (dto.newPassword === dto.currentPassword) {
      throw new BadRequestException("New password must differ from the current one");
    }
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: await bcrypt.hash(dto.newPassword, 12) },
      }),
      // Changing the password signs out other sessions
      this.prisma.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
    return { ok: true };
  }

  @Get("me/credits")
  async creditHistory(
    @CurrentUser() user: RequestUser,
    @Query() query: CreditHistoryQueryDto,
  ) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const [items, total, me] = await this.prisma.$transaction([
      this.prisma.creditTransaction.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.creditTransaction.count({ where: { userId: user.id } }),
      this.prisma.user.findUniqueOrThrow({
        where: { id: user.id },
        select: { creditBalance: true },
      }),
    ]);
    return {
      balance: me.creditBalance,
      items: items.map((t) => ({
        id: t.id,
        amount: t.amount,
        reason: t.reason,
        projectId: t.projectId,
        clipId: t.clipId,
        createdAt: t.createdAt.toISOString(),
      })),
      total,
      page,
      pageSize,
    };
  }
}
