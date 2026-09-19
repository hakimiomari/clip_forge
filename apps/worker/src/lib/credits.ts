import { getPrismaClient } from "@clipforge/database";

/** Refunds credits when a job fails after the API already charged. */
export async function refundCredits(
  userId: string,
  amount: number,
  refs?: { projectId?: string; clipId?: string },
): Promise<void> {
  if (amount <= 0) return;
  const prisma = getPrismaClient();
  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: { creditBalance: { increment: amount } },
    }),
    prisma.creditTransaction.create({
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
