import { HttpException, HttpStatus, Injectable } from "@nestjs/common";
import type { CreditReason } from "@clipforge/database";
import { PrismaService } from "../prisma/prisma.service";

export class InsufficientCreditsException extends HttpException {
  constructor(required: number, balance: number) {
    super(
      {
        message: `Insufficient credits: ${required} required, ${balance} available`,
        code: "INSUFFICIENT_CREDITS",
        required,
        balance,
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}

@Injectable()
export class UsageService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Atomically spends credits: fails with 402 when the balance is too low.
   * Uses a conditional update so concurrent spends can't overdraw.
   */
  async spend(
    userId: string,
    amount: number,
    reason: CreditReason,
    refs?: { projectId?: string; clipId?: string },
  ): Promise<void> {
    if (amount <= 0) return;
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.updateMany({
        where: { id: userId, creditBalance: { gte: amount } },
        data: { creditBalance: { decrement: amount } },
      });
      if (updated.count === 0) {
        const user = await tx.user.findUnique({
          where: { id: userId },
          select: { creditBalance: true },
        });
        throw new InsufficientCreditsException(amount, user?.creditBalance ?? 0);
      }
      await tx.creditTransaction.create({
        data: {
          userId,
          amount: -amount,
          reason,
          projectId: refs?.projectId,
          clipId: refs?.clipId,
        },
      });
    });
  }

  /** Refunds credits (e.g. when a queued job fails before doing work). */
  async refund(
    userId: string,
    amount: number,
    refs?: { projectId?: string; clipId?: string },
  ): Promise<void> {
    if (amount <= 0) return;
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { creditBalance: { increment: amount } },
      }),
      this.prisma.creditTransaction.create({
        data: {
          userId,
          amount,
          reason: "REFUND",
          projectId: refs?.projectId,
          clipId: refs?.clipId,
        },
      }),
    ]);
  }
}
