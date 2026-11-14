import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { PersistenceError } from "../persistence/errors";

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "127.0.0.2", "localhost", "::1"]);

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("::ffff:10.") ||
    normalized.startsWith("::ffff:192.168.") ||
    normalized.startsWith("::ffff:169.254.")
  );
}

function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPrivateIpv4(address);
  if (version === 6) return isPrivateIpv6(address);
  return true;
}

/**
 * Rejects outbound provider/bot URLs that resolve to private, link-local or
 * metadata addresses. This is the SSRF barrier for operator-supplied base URLs;
 * loopback remains opt-in for local model servers.
 *
 * DNS rebinding between this check and fetch cannot be fully eliminated without
 * a custom dispatcher, but redirects are disabled by callers and the resolver
 * result is checked on every request.
 */
export async function assertSafeOutboundUrl(
  raw: string,
  options: { allowLoopback?: boolean } = {},
): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PersistenceError("validation_failed", "出站地址不是有效 URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new PersistenceError("validation_failed", "出站地址只支持 HTTP(S)");
  }
  if (url.username || url.password) {
    throw new PersistenceError("validation_failed", "出站地址不能包含凭据");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const allowLoopback = options.allowLoopback === true;
  if (LOOPBACK_HOSTNAMES.has(hostname)) {
    if (!allowLoopback) {
      throw new PersistenceError("validation_failed", "出站地址不能使用本机回环地址");
    }
    return;
  }
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new PersistenceError("validation_failed", "出站地址不能指向私有或保留地址");
    }
    return;
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname, { all: true });
  } catch (error) {
    // A name that does not resolve now cannot be reached by fetch either. Keep
    // the fetch error path in charge; tests and offline hosts use fake names.
    if ((error as NodeJS.ErrnoException).code === "ENOTFOUND") {
      return;
    }
    throw new PersistenceError("unavailable", `无法解析出站地址：${hostname}`);
  }
  if (addresses.length === 0 || addresses.some((item) => isPrivateAddress(item.address))) {
    throw new PersistenceError("validation_failed", "出站地址解析到了私有或保留地址");
  }
}
