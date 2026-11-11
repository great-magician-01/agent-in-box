import fs from "node:fs";
import http from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureDesktopSession, type DesktopCookieJar } from "./control-plane-auth";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-in-box-desktop-auth-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

class MemoryCookieJar implements DesktopCookieJar {
  readonly values = new Map<string, string>();

  async get(filter: {
    url: string;
    name?: string;
  }): Promise<Array<{ name: string; value: string }>> {
    if (filter.name) {
      const value = this.values.get(filter.name);
      return value ? [{ name: filter.name, value }] : [];
    }
    return [...this.values.entries()].map(([name, value]) => ({ name, value }));
  }

  async set(details: { name: string; value: string }): Promise<void> {
    this.values.set(details.name, details.value);
  }

  async remove(_url: string, name: string): Promise<void> {
    this.values.delete(name);
  }
}

describe("desktop auto login", () => {
  it("uses the access key, stores the session cookie and reuses it", async () => {
    const key = "aib_test_access_key_0123456789abcdef";
    let logins = 0;
    const server = http.createServer((request, response) => {
      if (request.url === "/api/v1/auth/session") {
        const authenticated = String(request.headers.cookie ?? "").includes("aib_session=good");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ state: authenticated ? "authenticated" : "anonymous" }));
        return;
      }
      if (request.url === "/api/v1/auth/login" && request.method === "POST") {
        let body = "";
        request.on("data", (chunk) => (body += chunk));
        request.on("end", () => {
          logins += 1;
          const parsed = JSON.parse(body) as { accessKey?: string };
          if (parsed.accessKey !== key) {
            response.writeHead(401);
            response.end();
            return;
          }
          response.writeHead(200, {
            "content-type": "application/json",
            "set-cookie": "aib_session=good; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600",
          });
          response.end(JSON.stringify({ state: "authenticated" }));
        });
        return;
      }
      response.writeHead(404);
      response.end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const directory = temporaryDirectory();
    const accessKeyPath = path.join(directory, "web-access-key");
    fs.writeFileSync(accessKeyPath, `${key}\n`);
    const cookies = new MemoryCookieJar();
    try {
      const first = await ensureDesktopSession({
        baseUrl: `http://127.0.0.1:${port}`,
        accessKeyPath,
        cookies,
      });
      expect(first).toEqual({ authenticated: true, reason: null });
      expect(cookies.values.get("aib_session")).toBe("good");
      const second = await ensureDesktopSession({
        baseUrl: `http://127.0.0.1:${port}`,
        accessKeyPath,
        cookies,
      });
      expect(second.authenticated).toBe(true);
      expect(logins).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reports a clear failure when the access key is missing", async () => {
    const directory = temporaryDirectory();
    const result = await ensureDesktopSession({
      baseUrl: "http://127.0.0.1:9",
      accessKeyPath: path.join(directory, "missing"),
      cookies: new MemoryCookieJar(),
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    });
    expect(result.authenticated).toBe(false);
    expect(result.reason).toContain("不可读");
  });
});
