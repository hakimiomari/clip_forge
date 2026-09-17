import { ConflictException, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import * as bcrypt from "bcryptjs";
import { AuthService } from "./auth.service";
import type { PrismaService } from "../prisma/prisma.service";

const config = {
  getOrThrow: (key: string) => `${key}-secret-value-0123456789`,
  get: (key: string) =>
    key === "JWT_ACCESS_TTL" ? "15m" : key === "JWT_REFRESH_TTL" ? "7d" : undefined,
} as unknown as ConfigService;

function makePrisma(user: Record<string, unknown> | null) {
  return {
    user: {
      findUnique: jest.fn().mockResolvedValue(user),
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          id: "u1",
          role: "USER",
          plan: "FREE",
          creditBalance: 20,
          name: null,
          ...data,
        }),
      ),
    },
    refreshToken: {
      create: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
  } as unknown as PrismaService;
}

describe("AuthService", () => {
  const jwt = new JwtService({});

  it("registers a new user and returns tokens", async () => {
    const prisma = makePrisma(null);
    const service = new AuthService(prisma, jwt, config);
    const result = await service.register({
      email: "Ada@Example.com",
      password: "password123",
    });
    expect(result.user.email).toBe("ada@example.com");
    expect(result.tokens.accessToken).toBeTruthy();
    expect(result.tokens.refreshToken).toBeTruthy();
    // password is stored hashed, never in plaintext
    const createCall = (prisma.user.create as jest.Mock).mock.calls[0][0];
    expect(createCall.data.passwordHash).not.toContain("password123");
  });

  it("rejects duplicate registration", async () => {
    const prisma = makePrisma({ id: "u1", email: "ada@example.com" });
    const service = new AuthService(prisma, jwt, config);
    await expect(
      service.register({ email: "ada@example.com", password: "password123" }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("rejects login with wrong password", async () => {
    const passwordHash = await bcrypt.hash("correct-password", 4);
    const prisma = makePrisma({
      id: "u1",
      email: "ada@example.com",
      passwordHash,
      role: "USER",
      plan: "FREE",
      creditBalance: 20,
      name: null,
    });
    const service = new AuthService(prisma, jwt, config);
    await expect(
      service.login({ email: "ada@example.com", password: "wrong" }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("logs in with the correct password", async () => {
    const passwordHash = await bcrypt.hash("correct-password", 4);
    const prisma = makePrisma({
      id: "u1",
      email: "ada@example.com",
      passwordHash,
      role: "USER",
      plan: "FREE",
      creditBalance: 20,
      name: null,
    });
    const service = new AuthService(prisma, jwt, config);
    const result = await service.login({
      email: "ada@example.com",
      password: "correct-password",
    });
    expect(result.user.id).toBe("u1");
  });
});
