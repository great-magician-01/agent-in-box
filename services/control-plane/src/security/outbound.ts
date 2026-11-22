import { lookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";
import { PersistenceError } from "../persistence/errors";

interface IpAddress {
  kind(): "ipv4" | "ipv6";
  range(): string;
  isIPv4MappedAddress?(): boolean;
  toIPv4Address?(): IpAddress;
  match(other: IpAddress, prefix: number): boolean;
}

interface IpAddrModule {
  parse(value: string): IpAddress;
  parseCIDR(value: string): [IpAddress, number];
}

interface UndiciAgent {
  close(): Promise<void>;
  destroy(): Promise<void>;
}

interface UndiciModule {
  Agent: new (options: {
    connect: { lookup: LookupFunction; servername?: string; autoSelectFamily: false };
  }) => UndiciAgent;
  fetch(input: string, init: RequestInit & { dispatcher: unknown }): Promise<Response>;
}

// These are direct, exact dependencies of this package. Keeping the small
// structural types here also prevents an Undici version bump from silently
// changing the DNS-pinning surface used by the SSRF barrier.
import ipaddrModule from "ipaddr.js";
import * as undiciModule from "undici";

const ipaddr = ipaddrModule as unknown as IpAddrModule;
const undici = undiciModule as unknown as UndiciModule;

/**
 * Non-global/special-purpose destinations are never valid provider or bot
 * upstreams. ipaddr.js range classification covers IPv4/IPv6 multicast,
 * documentation, CGNAT, ULA, link-local, NAT64, Teredo and 6to4 ranges; the
 * explicit list also covers benchmarking and other IANA special registries
 * missing from older ipaddr.js data files.
 */
const BLOCKED_CIDRS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "::/96",
  "64:ff9b::/96",
  "64:ff9b:1::/48",
  "100::/64",
  "2001::/23",
  "2002::/16",
  "fc00::/7",
  "fe80::/10",
  "ff00::/8",
] as const;

const BLOCKED_NETWORKS = BLOCKED_CIDRS.map((cidr) => ipaddr.parseCIDR(cidr));
const LOOPBACK_NETWORKS = [ipaddr.parseCIDR("127.0.0.0/8"), ipaddr.parseCIDR("::1/128")];

export interface OutboundSecurityOptions {
  /** Loopback is an explicit opt-in for local model servers and test adapters. */
  allowLoopback?: boolean;
}

export interface VerifiedOutboundUrl {
  url: URL;
  addresses: Array<{ address: string; family: number }>;
}

function parseAddress(address: string): IpAddress | null {
  if (address.includes("%")) return null;
  try {
    let parsed = ipaddr.parse(address);
    if (parsed.kind() === "ipv6" && parsed.isIPv4MappedAddress?.()) {
      parsed = parsed.toIPv4Address!();
    }
    return parsed;
  } catch {
    return null;
  }
}

function matches(address: IpAddress, networks: Array<[IpAddress, number]>): boolean {
  return networks.some(([network, prefix]) => {
    try {
      return address.kind() === network.kind() && address.match(network, prefix);
    } catch {
      return true;
    }
  });
}

export function isLoopbackAddress(address: string): boolean {
  const parsed = parseAddress(address);
  return parsed !== null && matches(parsed, LOOPBACK_NETWORKS);
}

/** Only globally routable unicast addresses (plus explicitly allowed loopback) pass. */
export function isSafeOutboundAddress(address: string, allowLoopback = false): boolean {
  const parsed = parseAddress(address);
  if (!parsed) return false;
  if (matches(parsed, LOOPBACK_NETWORKS)) return allowLoopback;
  if (parsed.range() !== "unicast" || matches(parsed, BLOCKED_NETWORKS)) return false;
  return true;
}

/**
 * Parse, resolve and classify every returned address. DNS errors (including
 * ENOTFOUND) and empty answers fail closed. The returned addresses must be used
 * by the actual socket; checking alone does not prevent DNS rebinding.
 */
export async function resolveSafeOutboundUrl(
  raw: string,
  options: OutboundSecurityOptions = {},
): Promise<VerifiedOutboundUrl> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PersistenceError("validation_failed", "出站地址不是有效 URL");
  }
  const supported = ["https:", "http:", "wss:", "ws:"];
  if (!supported.includes(url.protocol)) {
    throw new PersistenceError("validation_failed", "出站地址只支持 HTTP(S) 或 WS(S)");
  }
  if (url.username || url.password) {
    throw new PersistenceError("validation_failed", "出站地址不能包含凭据");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname) {
    throw new PersistenceError("validation_failed", "出站地址缺少主机名");
  }

  const literal = parseAddress(hostname);
  let addresses: Array<{ address: string; family: number }>;
  if (literal) {
    addresses = [
      {
        address: literal.kind() === "ipv6" ? hostname : literal.toString(),
        family: literal.kind() === "ipv6" ? 6 : 4,
      },
    ];
  } else if (/^[0-9.]+$/.test(hostname) || hostname.includes(":")) {
    // Reject malformed/legacy numeric IP forms rather than asking DNS to
    // interpret them as a hostname.
    throw new PersistenceError("validation_failed", "出站地址包含无效 IP 地址");
  } else {
    try {
      addresses = await lookup(hostname, { all: true, verbatim: true });
    } catch {
      throw new PersistenceError("unavailable", `无法解析出站地址：${hostname}`);
    }
  }

  const allowLoopback = options.allowLoopback === true;
  if (
    addresses.length === 0 ||
    addresses.some((item) => !isSafeOutboundAddress(item.address, allowLoopback))
  ) {
    const loopback = addresses.some((item) => isLoopbackAddress(item.address));
    throw new PersistenceError(
      "validation_failed",
      loopback && !allowLoopback
        ? "出站地址不能使用本机回环地址"
        : "出站地址不能指向私有、保留或非全局地址",
    );
  }
  return { url, addresses };
}

export async function assertSafeOutboundUrl(
  raw: string,
  options: OutboundSecurityOptions = {},
): Promise<void> {
  await resolveSafeOutboundUrl(raw, options);
}

/** A fixed lookup callback; no system DNS query is permitted during connect. */
export function fixedDnsLookup(
  addresses: ReadonlyArray<{ address: string; family: number }>,
): LookupFunction {
  const pinned = addresses.map(({ address, family }) => ({ address, family }));
  return (_hostname, options, callback) => {
    if (pinned.length === 0) {
      const error = new Error("no verified DNS addresses") as NodeJS.ErrnoException;
      error.code = "ENOTFOUND";
      callback(error, []);
      return;
    }
    if (options.all) {
      callback(null, pinned);
      return;
    }
    const first = pinned[0]!;
    callback(null, first.address, first.family);
  };
}

/**
 * Fetch with a one-request Undici Agent pinned to the addresses validated above.
 * The original URL remains the request origin, so HTTP Host and TLS SNI/certificate
 * verification still use the configured hostname rather than the pinned IP.
 */
export async function fetchSafeOutbound(
  raw: string,
  init: RequestInit = {},
  options: OutboundSecurityOptions = {},
): Promise<Response> {
  const verified = await resolveSafeOutboundUrl(raw, options);
  const hostname = verified.url.hostname.replace(/^\[|\]$/g, "");
  const agent = new undici.Agent({
    connect: {
      lookup: fixedDnsLookup(verified.addresses),
      autoSelectFamily: false,
      ...(verified.url.protocol === "https:" ? { servername: hostname } : {}),
    },
  });
  try {
    const response = await undici.fetch(verified.url.toString(), {
      ...init,
      redirect: "error",
      dispatcher: agent,
    });
    // Graceful close stops new connections while allowing the caller to consume
    // streamed response bodies. The Agent remains referenced by that response.
    void agent.close().catch(() => undefined);
    return response;
  } catch (error) {
    await agent.destroy().catch(() => undefined);
    throw error;
  }
}
