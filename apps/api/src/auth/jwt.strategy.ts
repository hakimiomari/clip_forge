import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import type { Request } from "express";
import type { RequestUser } from "../common/decorators/current-user.decorator";

export interface AccessTokenPayload {
  sub: string;
  email: string;
  role: "USER" | "ADMIN";
}

function cookieExtractor(req: Request): string | null {
  return (req.cookies?.["cf_access"] as string | undefined) ?? null;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, "jwt") {
  constructor(config: ConfigService) {
    const secret = config.get<string>("JWT_SECRET");
    if (!secret) throw new Error("JWT_SECRET is not configured");
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        cookieExtractor,
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      ignoreExpiration: false,
      secretOrKey: secret,
    });
  }

  validate(payload: AccessTokenPayload): RequestUser {
    if (!payload?.sub) throw new UnauthorizedException();
    return { id: payload.sub, email: payload.email, role: payload.role };
  }
}
