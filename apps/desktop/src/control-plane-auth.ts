import fs from "node:fs";

export interface DesktopCookie {
  name: string;
  value: string;
}

export interface DesktopCookieJar {
  get(filter: { url: string; name?: string }): Promise<DesktopCookie[]>;
  set(details: {
    url: string;
    name: string;
    value: string;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "unspecified" | "no_restriction" | "lax" | "strict";
    expirationDate?: number;
  }): Promise<void>;
  remove(url: string, name: string): Promise<void>;
}

export interface DesktopAuthDependencies {
  baseUrl: string;
  accessKeyPath: string;
  cookies: DesktopCookieJar;
  fetchImpl?: typeof fetch;
  logger?: { info(message: string): void; warn(message: string, data?: unknown): void };
}

export interface DesktopAuthResult {
  authenticated: boolean;
  reason: string | null;
}

export const SESSION_COOKIE = "aib_session";

function cookieHeader(cookies: DesktopCookie[]): string {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

function firstSetCookie(headers: Headers): string | null {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getSetCookie === "function") {
    return getSetCookie.call(headers)[0] ?? null;
  }
  const combined = headers.get("set-cookie");
  return combined ? (combined.split(/,(?=[^;]+?=)/)[0] ?? null) : null;
}

function parseSetCookie(raw: string): {
  name: string;
  value: string;
  maxAgeSeconds: number | null;
} | null {
  const parts = raw.split(";");
  const first = parts.shift()?.trim();
  if (!first) return null;
  const separator = first.indexOf("=");
  if (separator <= 0) return null;
  const name = first.slice(0, separator).trim();
  const value = first.slice(separator + 1).trim();
  let maxAgeSeconds: number | null = null;
  for (const part of parts) {
    const match = /^max-age=(\d+)$/i.exec(part.trim());
    if (match) {
      maxAgeSeconds = Number(match[1]);
    }
  }
  return name && value ? { name, value, maxAgeSeconds } : null;
}

async function authenticated(
  deps: DesktopAuthDependencies,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  const cookies = await deps.cookies.get({ url: deps.baseUrl });
  if (cookies.length === 0) return false;
  const response = await fetchImpl(`${deps.baseUrl}/api/v1/auth/session`, {
    headers: { accept: "application/json", cookie: cookieHeader(cookies) },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) return false;
  const body = (await response.json()) as { state?: unknown };
  return body.state === "authenticated";
}

/**
 * Electron main owns the local access key and injects the resulting session
 * cookie into the renderer's cookie jar. The sandboxed renderer never receives
 * the access key itself.
 */
export async function ensureDesktopSession(
  deps: DesktopAuthDependencies,
): Promise<DesktopAuthResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;

  try {
    if (await authenticated(deps, fetchImpl)) {
      return { authenticated: true, reason: null };
    }
  } catch (error) {
    deps.logger?.warn("检查桌面会话失败", { error: String(error) });
  }

  let accessKey: string;
  try {
    accessKey = fs.readFileSync(deps.accessKeyPath, "utf8").trim();
  } catch (error) {
    return {
      authenticated: false,
      reason: `本机访问密钥不可读：${(error as NodeJS.ErrnoException).code ?? String(error)}`,
    };
  }
  if (!accessKey) {
    return { authenticated: false, reason: "本机访问密钥为空" };
  }

  try {
    const response = await fetchImpl(`${deps.baseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ accessKey, label: "desktop-shell" }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return { authenticated: false, reason: `桌面自动登录失败：HTTP ${response.status}` };
    }
    const setCookie = firstSetCookie(response.headers);
    const parsed = setCookie ? parseSetCookie(setCookie) : null;
    if (!parsed) {
      return { authenticated: false, reason: "桌面自动登录没有返回会话 Cookie" };
    }
    await deps.cookies.set({
      url: deps.baseUrl,
      name: parsed.name,
      value: parsed.value,
      httpOnly: true,
      secure: deps.baseUrl.startsWith("https:"),
      sameSite: "strict",
      ...(parsed.maxAgeSeconds !== null
        ? { expirationDate: Date.now() / 1000 + parsed.maxAgeSeconds }
        : {}),
    });
    if (await authenticated(deps, fetchImpl)) {
      deps.logger?.info("桌面渲染进程已通过本机访问密钥建立会话");
      return { authenticated: true, reason: null };
    }
    return { authenticated: false, reason: "桌面会话 Cookie 未生效" };
  } catch (error) {
    return { authenticated: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
