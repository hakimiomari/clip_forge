export * from "@prisma/client";
export { PrismaClient, Prisma } from "@prisma/client";

import { PrismaClient } from "@prisma/client";

let prisma: PrismaClient | undefined;

/**
 * Shared singleton for processes that want a single connection pool
 * (worker, scripts). The NestJS API wraps PrismaClient in its own
 * lifecycle-managed provider instead.
 */
export function getPrismaClient(): PrismaClient {
  if (!prisma) {
    prisma = new PrismaClient();
  }
  return prisma;
}
