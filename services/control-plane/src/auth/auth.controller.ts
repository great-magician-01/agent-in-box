import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import type {
  LocalAuthLoginRequest,
  LocalAuthRotateResult,
  LocalAuthSessionView,
} from "@agent-in-box/protocol";
import { PersistenceError } from "../persistence/errors";
import { AuthService, clearedSessionCookieHeader, sessionCookieHeader } from "./auth.service";
import { Public, type AuthenticatedRequest } from "./auth.guard";

@Controller("/api/v1/auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Get("session")
  async session(@Req() request: Request): Promise<LocalAuthSessionView> {
    const session = await this.auth.authenticateRequest(request.headers);
    return this.auth.sessionView(session, isDesktopShell(request));
  }

  @Public()
  @Post("login")
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: LocalAuthLoginRequest,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LocalAuthSessionView> {
    const result = await this.auth.login({
      accessKey: body?.accessKey,
      label:
        body?.label ?? `${isDesktopShell(request) ? "desktop" : "browser"} ${request.ip ?? ""}`,
      ...(request.ip ? { remoteAddress: request.ip } : {}),
    });
    response.setHeader(
      "Set-Cookie",
      sessionCookieHeader({
        token: result.token,
        maxAgeSeconds: Math.floor((Date.parse(result.session.expiresAt) - Date.now()) / 1000),
        secure: request.protocol === "https",
      }),
    );
    response.setHeader("Cache-Control", "no-store");
    return this.auth.sessionView(result.session, isDesktopShell(request));
  }

  @Post("logout")
  @HttpCode(HttpStatus.OK)
  async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LocalAuthSessionView> {
    const session = request.authSession;
    if (session) {
      await this.auth.logout(session.id);
    }
    response.setHeader("Set-Cookie", clearedSessionCookieHeader());
    response.setHeader("Cache-Control", "no-store");
    return this.auth.sessionView(null, isDesktopShell(request));
  }

  @Post("rotate")
  @HttpCode(HttpStatus.OK)
  async rotate(@Req() request: AuthenticatedRequest): Promise<LocalAuthRotateResult> {
    const session = request.authSession;
    if (!session || session.user.role !== "admin") {
      throw new PersistenceError("forbidden", "只有本机管理员可以更换访问密钥");
    }
    const result = await this.auth.rotateAccessKey(session.id === "access-key" ? null : session.id);
    return {
      accessKeyPath: this.auth.accessKeyPath(),
      rotatedAt: result.rotatedAt as LocalAuthRotateResult["rotatedAt"],
      revokedSessions: result.revokedSessions,
    };
  }
}

function isDesktopShell(request: Request): boolean {
  const userAgent = request.headers["user-agent"];
  return typeof userAgent === "string" && /\bElectron\//.test(userAgent);
}
