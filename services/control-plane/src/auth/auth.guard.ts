import { timingSafeEqual } from "node:crypto";
import {
  Inject,
  Injectable,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { PersistenceError } from "../persistence/errors";
import { AuthService, type AuthSession } from "./auth.service";

export const IS_PUBLIC_KEY = "agent-in-box:public";
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

export const CSRF_HEADER = "x-agent-in-box-csrf";
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface AuthenticatedRequest extends Request {
  authSession?: AuthSession;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Even public routes must be addressed to loopback and, when a browser sends
 * Origin/Sec-Fetch-Site, must be same-origin. This blocks a malicious page on
 * another local port from using this service as a confused deputy.
 */
export function validateLocalRequest(request: Request): void {
  const host = headerValue(request.headers.host);
  if (!host) {
    throw new PersistenceError("forbidden", "缺少 Host 请求头");
  }
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, "");
  } catch {
    throw new PersistenceError("forbidden", "Host 请求头无效");
  }
  if (!LOOPBACK_HOSTNAMES.has(hostname)) {
    throw new PersistenceError("forbidden", "只接受本机回环地址访问");
  }

  const origin = headerValue(request.headers.origin);
  if (origin) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new PersistenceError("forbidden", "Origin 请求头无效");
    }
    if (parsed.protocol !== "http:" || parsed.host !== host) {
      throw new PersistenceError("forbidden", "拒绝跨站请求");
    }
  }

  const fetchSite = headerValue(request.headers["sec-fetch-site"]);
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw new PersistenceError("forbidden", "拒绝跨站浏览器请求");
  }
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    validateLocalRequest(request);

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const session = await this.auth.authenticateRequest(request.headers);
    if (!session) {
      throw new PersistenceError("unauthorized", "需要本机登录后才能操作");
    }

    if (UNSAFE_METHODS.has(request.method.toUpperCase()) && !session.viaAccessKey) {
      const csrf = headerValue(request.headers[CSRF_HEADER]);
      if (!csrf || !session.csrfToken || !safeEqual(csrf, session.csrfToken)) {
        throw new PersistenceError("forbidden", "CSRF 校验失败，请刷新页面后重试");
      }
    }

    request.authSession = session;
    return true;
  }
}
