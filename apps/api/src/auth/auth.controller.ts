import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Request, Response } from "express";
import { AuthService, TokenPair } from "./auth.service";
import { LoginDto, RegisterDto } from "./dto/auth.dto";
import { Public } from "../common/decorators/public.decorator";
import {
  CurrentUser,
  RequestUser,
} from "../common/decorators/current-user.decorator";

const ACCESS_COOKIE = "cf_access";
const REFRESH_COOKIE = "cf_refresh";

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  private readonly isProd: boolean;

  constructor(
    private readonly auth: AuthService,
    config: ConfigService,
  ) {
    this.isProd = config.get("NODE_ENV") === "production";
  }

  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Post("register")
  async register(
    @Body() dto: RegisterDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { user, tokens } = await this.auth.register(dto);
    this.setAuthCookies(res, tokens);
    return { user };
  }

  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 15 } })
  @HttpCode(200)
  @Post("login")
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { user, tokens } = await this.auth.login(dto);
    this.setAuthCookies(res, tokens);
    return { user };
  }

  @Public()
  @HttpCode(200)
  @Post("refresh")
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
    if (!token) {
      this.clearAuthCookies(res);
      return { user: null };
    }
    try {
      const { user, tokens } = await this.auth.refresh(token);
      this.setAuthCookies(res, tokens);
      return { user };
    } catch (err) {
      this.clearAuthCookies(res);
      throw err;
    }
  }

  @Public()
  @HttpCode(200)
  @Post("logout")
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.logout(req.cookies?.[REFRESH_COOKIE]);
    this.clearAuthCookies(res);
    return { ok: true };
  }

  @Get("me")
  async me(@CurrentUser() user: RequestUser) {
    return { user: await this.auth.me(user.id) };
  }

  private setAuthCookies(res: Response, tokens: TokenPair): void {
    const base = {
      httpOnly: true,
      secure: this.isProd,
      sameSite: "lax" as const,
      path: "/",
    };
    // Access cookie: sent on all API requests
    res.cookie(ACCESS_COOKIE, tokens.accessToken, {
      ...base,
      maxAge: 15 * 60 * 1000,
    });
    // Refresh cookie: full path so /auth/refresh + /auth/logout both see it
    res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
      ...base,
      maxAge: tokens.refreshExpiresAt.getTime() - Date.now(),
    });
  }

  private clearAuthCookies(res: Response): void {
    res.clearCookie(ACCESS_COOKIE, { path: "/" });
    res.clearCookie(REFRESH_COOKIE, { path: "/" });
  }
}
