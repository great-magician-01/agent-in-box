import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import type { Kysely } from "kysely";
import type { LocalAuthSessionView, LocalAuthUser, LocalUserRole } from "@agent-in-box/protocol";
import { KYSELY } from "../persistence/tokens";
import { PersistenceError } from "../persistence/errors";
import type { DatabaseSchema } from "../persistence/schema";
import { nowIso } from "../persistence/time";

export const AUTH_OPTIONS = Symbol("AUTH_OPTIONS");

export const SESSION_COOKIE_NAME = "aib_session";
export const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const ACCESS_KEY_BYTES = 32;
const SESSION_TOKEN_BYTES = 32;
const MAX_LOGIN_FAILURES = 5;
const LOGIN_BLOCK_MS = 30_000;
const MAX_LABEL_LENGTH = 80;

export interface AuthOptions {
  accessKeyPath: string;
  sessionTtlMs?: number;
  now?: () => Date;
  randomBytes?: (size: number) => Buffer;
}

export interface AuthSession {
  /** SHA-256 hash stored in auth_sessions.id. */
  id: string;
  user: LocalAuthUser;
  csrfToken: string | null;
  expiresAt: string;
  viaAccessKey: boolean;
}

export interface AuthRequestHeaders {
  cookie?: string | string[] | undefined;
  authorization?: string | string[] | undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function parseCookieHeader(header: string | string[] | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  const raw = Array.isArray(header) ? header.join(";") : header;
  if (!raw) {
    return cookies;
  }
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name) {
      continue;
    }
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

export function bearerToken(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match?.[1]?.trim() || null;
}

export function sessionCookieHeader(input: {
  token: string;
  maxAgeSeconds: number;
  secure?: boolean;
}): string {
  return [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(input.token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${input.maxAgeSeconds}`,
    ...(input.secure ? ["Secure"] : []),
  ].join("; ");
}

export function clearedSessionCookieHeader(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly sessionTtlMs: number;
  private readonly now: () => Date;
  private readonly randomBytes: (size: number) => Buffer;
  private readonly loginFailures = new Map<string, { count: number; blockedUntil: number }>();

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DatabaseSchema>,
    @Inject(AUTH_OPTIONS) private readonly options: AuthOptions,
  ) {
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.now = options.now ?? (() => new Date());
    this.randomBytes = options.randomBytes ?? randomBytes;
  }

  async onModuleInit(): Promise<void> {
    this.ensureAccessKey();
    await this.purgeExpiredSessions();
  }

  accessKeyPath(): string {
    return this.options.accessKeyPath;
  }

  ensureAccessKey(): string {
    const directory = path.dirname(this.options.accessKeyPath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      const existing = fs.readFileSync(this.options.accessKeyPath, "utf8").trim();
      if (existing.length >= 32) {
        return existing;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    return this.writeNewAccessKey();
  }

  async rotateAccessKey(
    keepSessionId: string | null,
  ): Promise<{ rotatedAt: string; revokedSessions: number }> {
    const rotatedAt = nowIso(this.now());
    this.writeNewAccessKey();
    let query = this.db.deleteFrom("auth_sessions");
    if (keepSessionId && keepSessionId !== "access-key") {
      query = query.where("id", "!=", keepSessionId);
    }
    const result = await query.executeTakeFirst();
    return { rotatedAt, revokedSessions: Number(result.numDeletedRows ?? 0) };
  }

  async login(input: {
    accessKey: unknown;
    label?: unknown;
    remoteAddress?: string;
  }): Promise<{ token: string; session: AuthSession; user: LocalAuthUser }> {
    const source = input.remoteAddress ?? "local";
    this.assertNotBlocked(source);
    if (typeof input.accessKey !== "string" || input.accessKey.length < 8) {
      this.recordFailure(source);
      throw new PersistenceError("unauthorized", "本机访问密钥无效");
    }
    const expected = this.readAccessKey();
    if (!safeEqual(input.accessKey.trim(), expected)) {
      this.recordFailure(source);
      throw new PersistenceError("unauthorized", "本机访问密钥无效");
    }
    this.loginFailures.delete(source);

    const token = this.randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
    const csrfToken = this.randomBytes(24).toString("base64url");
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + this.sessionTtlMs).toISOString();
    const user = await this.resolveUser();
    const label =
      typeof input.label === "string" && input.label.trim()
        ? input.label.trim().slice(0, MAX_LABEL_LENGTH)
        : "local";

    await this.db
      .insertInto("auth_sessions")
      .values({
        id: sha256(token),
        user_id: user.id,
        role: user.role,
        csrf_token: csrfToken,
        label,
        created_at: createdAt.toISOString(),
        last_seen_at: createdAt.toISOString(),
        expires_at: expiresAt,
      })
      .execute();

    return {
      token,
      session: { id: sha256(token), user, csrfToken, expiresAt, viaAccessKey: false },
      user,
    };
  }

  /**
   * Accepts either a browser session cookie or an explicit Bearer access key.
   * The access key path exists for local CLI/Smoke use; browsers cannot send
   * an Authorization header cross-origin without a CORS preflight, which this
   * server never approves.
   */
  async authenticateRequest(headers: AuthRequestHeaders): Promise<AuthSession | null> {
    const key = bearerToken(headers.authorization);
    if (key) {
      const expected = this.readAccessKey();
      if (safeEqual(key, expected)) {
        return {
          id: "access-key",
          user: await this.resolveUser(),
          csrfToken: null,
          expiresAt: new Date(this.now().getTime() + this.sessionTtlMs).toISOString(),
          viaAccessKey: true,
        };
      }
      return null;
    }
    const cookies = parseCookieHeader(headers.cookie);
    const token = cookies[SESSION_COOKIE_NAME];
    return token ? this.authenticateSessionToken(token) : null;
  }

  async authenticateSessionToken(token: string): Promise<AuthSession | null> {
    if (!token || token.length > 512) {
      return null;
    }
    const id = sha256(token);
    const row = await this.db
      .selectFrom("auth_sessions")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) {
      return null;
    }
    const now = this.now();
    if (row.expires_at <= now.toISOString()) {
      await this.db.deleteFrom("auth_sessions").where("id", "=", id).execute();
      return null;
    }
    await this.db
      .updateTable("auth_sessions")
      .set({ last_seen_at: now.toISOString() })
      .where("id", "=", id)
      .execute();
    return {
      id,
      user: await this.resolveUser(),
      csrfToken: row.csrf_token,
      expiresAt: row.expires_at,
      viaAccessKey: false,
    };
  }

  async sessionView(
    session: AuthSession | null,
    desktopShell = false,
  ): Promise<LocalAuthSessionView> {
    return {
      state: session ? "authenticated" : "anonymous",
      user: session?.user ?? null,
      csrfToken: session?.csrfToken ?? null,
      expiresAt: session?.expiresAt ?? null,
      accessKeyPath: this.options.accessKeyPath,
      desktopShell,
    };
  }

  async logout(sessionId: string): Promise<void> {
    if (sessionId === "access-key") {
      return;
    }
    await this.db.deleteFrom("auth_sessions").where("id", "=", sessionId).execute();
  }

  async purgeExpiredSessions(): Promise<number> {
    const result = await this.db
      .deleteFrom("auth_sessions")
      .where("expires_at", "<=", nowIso(this.now()))
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0);
  }

  private readAccessKey(): string {
    try {
      const value = fs.readFileSync(this.options.accessKeyPath, "utf8").trim();
      if (value.length >= 32) {
        return value;
      }
    } catch {
      // Fall through to an explicit error: the control plane must not start
      // with an unusable authentication credential.
    }
    throw new PersistenceError("unavailable", "本机访问密钥不可用，请检查配置目录权限");
  }

  private writeNewAccessKey(): string {
    const key = `aib_${this.randomBytes(ACCESS_KEY_BYTES).toString("base64url")}`;
    const directory = path.dirname(this.options.accessKeyPath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.options.accessKeyPath}.${process.pid}.${this.now().getTime()}.tmp`;
    fs.writeFileSync(temporary, `${key}\n`, { mode: 0o600 });
    try {
      fs.renameSync(temporary, this.options.accessKeyPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "EPERM") {
        fs.rmSync(this.options.accessKeyPath, { force: true });
        fs.renameSync(temporary, this.options.accessKeyPath);
      } else {
        fs.rmSync(temporary, { force: true });
        throw error;
      }
    }
    try {
      fs.chmodSync(this.options.accessKeyPath, 0o600);
    } catch {
      // POSIX modes are not available on every platform.
    }
    return key;
  }

  private async resolveUser(): Promise<LocalAuthUser> {
    const row = await this.db
      .selectFrom("local_users")
      .selectAll()
      .where("role", "=", "admin")
      .orderBy("created_at", "asc")
      .executeTakeFirst();
    return row
      ? {
          id: row.id,
          displayName: row.display_name,
          role: row.role as LocalUserRole,
        }
      : { id: "local-admin", displayName: "本机管理员", role: "admin" };
  }

  private assertNotBlocked(source: string): void {
    const state = this.loginFailures.get(source);
    if (state && state.blockedUntil > this.now().getTime()) {
      const seconds = Math.ceil((state.blockedUntil - this.now().getTime()) / 1000);
      throw new PersistenceError(
        "rate_limited",
        `本机访问密钥尝试过于频繁，请在 ${seconds} 秒后重试`,
      );
    }
  }

  private recordFailure(source: string): void {
    const state = this.loginFailures.get(source) ?? { count: 0, blockedUntil: 0 };
    state.count += 1;
    if (state.count >= MAX_LOGIN_FAILURES) {
      state.blockedUntil = this.now().getTime() + LOGIN_BLOCK_MS;
      state.count = 0;
    }
    this.loginFailures.set(source, state);
  }
}
