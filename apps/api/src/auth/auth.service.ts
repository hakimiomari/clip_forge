import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { createHash, randomBytes } from "crypto";
import * as bcrypt from "bcryptjs";
import type { AuthUser } from "@clipforge/shared-types";
import { PrismaService } from "../prisma/prisma.service";
import type { AccessTokenPayload } from "./jwt.strategy";

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** Refresh token DB expiry, for cookie maxAge */
  refreshExpiresAt: Date;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Parses TTLs like "15m", "7d", "3600" (seconds) into seconds. */
export function parseTtlSeconds(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const match = value.trim().match(/^(\d+)([smhd]?)$/);
  if (!match) return fallback;
  const amount = Number(match[1]);
  const unit = match[2] ?? "";
  const multiplier =
    unit === "m" ? 60 : unit === "h" ? 3600 : unit === "d" ? 86400 : 1;
  return amount * multiplier;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async register(input: {
    name?: string;
    email: string;
    password: string;
  }): Promise<{ user: AuthUser; tokens: TokenPair }> {
    const email = input.email.toLowerCase().trim();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new ConflictException("An account with this email already exists");
    }
    const passwordHash = await bcrypt.hash(input.password, 12);
    const user = await this.prisma.user.create({
      data: { email, name: input.name?.trim() || null, passwordHash },
    });
    const tokens = await this.issueTokens(user.id, user.email, user.role);
    return { user: this.toAuthUser(user), tokens };
  }

  async login(input: {
    email: string;
    password: string;
  }): Promise<{ user: AuthUser; tokens: TokenPair }> {
    const email = input.email.toLowerCase().trim();
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user?.passwordHash) {
      throw new UnauthorizedException("Invalid email or password");
    }
    const valid = await bcrypt.compare(input.password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException("Invalid email or password");
    }
    if (user.suspendedAt) {
      throw new UnauthorizedException("This account has been suspended");
    }
    const tokens = await this.issueTokens(user.id, user.email, user.role);
    return { user: this.toAuthUser(user), tokens };
  }

  /** Rotates the refresh token: verifies, revokes the old, issues a new pair. */
  async refresh(refreshToken: string): Promise<{ user: AuthUser; tokens: TokenPair }> {
    let payload: { sub: string };
    try {
      payload = await this.jwt.verifyAsync(refreshToken, {
        secret: this.config.getOrThrow<string>("JWT_REFRESH_SECRET"),
      });
    } catch {
      throw new UnauthorizedException("Invalid refresh token");
    }

    const tokenHash = sha256(refreshToken);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
    });
    if (
      !stored ||
      stored.revokedAt ||
      stored.userId !== payload.sub ||
      stored.expiresAt < new Date()
    ) {
      // Possible replay of a rotated token — revoke the whole family.
      if (stored) {
        await this.prisma.refreshToken.updateMany({
          where: { userId: stored.userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
      throw new UnauthorizedException("Refresh token is no longer valid");
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
    });
    if (!user) throw new UnauthorizedException();
    if (user.suspendedAt) {
      throw new UnauthorizedException("This account has been suspended");
    }

    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });
    const tokens = await this.issueTokens(user.id, user.email, user.role);
    return { user: this.toAuthUser(user), tokens };
  }

  async logout(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) return;
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: sha256(refreshToken) },
      data: { revokedAt: new Date() },
    });
  }

  async me(userId: string): Promise<AuthUser> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();
    return this.toAuthUser(user);
  }

  private async issueTokens(
    userId: string,
    email: string,
    role: "USER" | "ADMIN",
  ): Promise<TokenPair> {
    const accessTtl = parseTtlSeconds(
      this.config.get<string>("JWT_ACCESS_TTL"),
      15 * 60,
    );
    const refreshTtl = parseTtlSeconds(
      this.config.get<string>("JWT_REFRESH_TTL"),
      7 * 24 * 3600,
    );
    const payload: AccessTokenPayload = { sub: userId, email, role };
    const accessToken = await this.jwt.signAsync(payload, {
      secret: this.config.getOrThrow<string>("JWT_SECRET"),
      expiresIn: accessTtl,
    });
    // jti makes every refresh token unique even within the same second
    const refreshToken = await this.jwt.signAsync(
      { sub: userId, jti: randomBytes(16).toString("hex") },
      {
        secret: this.config.getOrThrow<string>("JWT_REFRESH_SECRET"),
        expiresIn: refreshTtl,
      },
    );
    const refreshExpiresAt = new Date(Date.now() + refreshTtl * 1000);
    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: sha256(refreshToken),
        expiresAt: refreshExpiresAt,
      },
    });
    return { accessToken, refreshToken, refreshExpiresAt };
  }

  private toAuthUser(user: {
    id: string;
    email: string;
    name: string | null;
    role: "USER" | "ADMIN";
    plan: "FREE" | "STARTER" | "PRO" | "BUSINESS";
    creditBalance: number;
  }): AuthUser {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      plan: user.plan,
      creditBalance: user.creditBalance,
    };
  }
}
