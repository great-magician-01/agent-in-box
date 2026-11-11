import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestContext, type TestContext } from "../persistence/testing/fixtures";
import { PersistenceError } from "../persistence/errors";
import {
  AuthService,
  DEFAULT_SESSION_TTL_MS,
  parseCookieHeader,
  sessionCookieHeader,
} from "./auth.service";
import { validateLocalRequest } from "./auth.guard";
import type { Request } from "express";

let ctx: TestContext;
let directory: string;
let accessKeyPath: string;
let auth: AuthService;

beforeEach(async () => {
  ctx = await createTestContext();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-in-box-auth-"));
  accessKeyPath = path.join(directory, "web-access-key");
  auth = new AuthService(ctx.app.db, { accessKeyPath });
  await auth.onModuleInit();
});

afterEach(async () => {
  await ctx.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

function readKey(): string {
  return fs.readFileSync(accessKeyPath, "utf8").trim();
}

describe("AuthService", () => {
  it("creates a private access key and authenticates with it", async () => {
    const key = readKey();
    expect(key).toMatch(/^aib_[A-Za-z0-9_-]{20,}$/);
    if (process.platform !== "win32") {
      expect(fs.statSync(accessKeyPath).mode & 0o777).toBe(0o600);
    }

    const result = await auth.login({ accessKey: key, label: "test browser" });
    expect(result.session.csrfToken).toMatch(/^[A-Za-z0-9_-]+$/);
    const cookie = sessionCookieHeader({
      token: result.token,
      maxAgeSeconds: DEFAULT_SESSION_TTL_MS / 1000,
    });
    const parsed = parseCookieHeader(cookie);
    const session = await auth.authenticateRequest({ cookie });
    expect(session?.user.displayName).toBe("本机管理员");
    expect(session?.csrfToken).toBe(result.session.csrfToken);
    expect(parsed.aib_session).toBe(result.token);
  });

  it("rejects a wrong key and rate-limits repeated failures", async () => {
    await expect(auth.login({ accessKey: "wrong-key-value" })).rejects.toMatchObject({
      code: "unauthorized",
    });
    const error = await auth
      .login({ accessKey: "wrong-key-value" })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PersistenceError);
    for (let index = 0; index < 6; index += 1) {
      await auth.login({ accessKey: "wrong-key-value" }).catch(() => undefined);
    }
    await expect(auth.login({ accessKey: readKey() })).rejects.toMatchObject({
      code: "rate_limited",
    });
  });

  it("accepts the access key as a Bearer credential without CSRF state", async () => {
    const session = await auth.authenticateRequest({
      authorization: `Bearer ${readKey()}`,
    });
    expect(session?.viaAccessKey).toBe(true);
    expect(session?.csrfToken).toBeNull();
  });

  it("rotates the key and revokes other sessions while keeping the caller", async () => {
    const first = await auth.login({ accessKey: readKey(), label: "first" });
    const second = await auth.login({ accessKey: readKey(), label: "second" });
    const oldKey = readKey();
    const result = await auth.rotateAccessKey(first.session.id);
    expect(result.revokedSessions).toBe(1);
    expect(readKey()).not.toBe(oldKey);
    expect(await auth.authenticateSessionToken(first.token)).not.toBeNull();
    expect(await auth.authenticateSessionToken(second.token)).toBeNull();
    await expect(auth.login({ accessKey: oldKey })).rejects.toMatchObject({
      code: "unauthorized",
    });
    await expect(auth.login({ accessKey: readKey() })).resolves.toBeTruthy();
  });

  it("expires sessions without relying on process memory", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const expiring = new AuthService(ctx.app.db, {
      accessKeyPath,
      sessionTtlMs: 1000,
      now: () => now,
    });
    await expiring.onModuleInit();
    const result = await expiring.login({ accessKey: readKey() });
    expect(await expiring.authenticateSessionToken(result.token)).not.toBeNull();
    now = new Date("2026-01-01T00:00:02.000Z");
    expect(await expiring.authenticateSessionToken(result.token)).toBeNull();
  });
});

describe("validateLocalRequest", () => {
  function request(headers: Record<string, string>): Request {
    return { headers } as unknown as Request;
  }

  it("accepts loopback same-origin requests", () => {
    expect(() =>
      validateLocalRequest(
        request({
          host: "127.0.0.1:3000",
          origin: "http://127.0.0.1:3000",
          "sec-fetch-site": "same-origin",
        }),
      ),
    ).not.toThrow();
  });

  it("rejects another local port, cross-site fetches and non-loopback hosts", () => {
    expect(() =>
      validateLocalRequest(request({ host: "127.0.0.1:3000", origin: "http://127.0.0.1:9999" })),
    ).toThrow(/跨站/);
    expect(() =>
      validateLocalRequest(request({ host: "127.0.0.1:3000", "sec-fetch-site": "same-site" })),
    ).toThrow(/跨站/);
    expect(() => validateLocalRequest(request({ host: "evil.example:3000" }))).toThrow(/回环/);
  });
});
