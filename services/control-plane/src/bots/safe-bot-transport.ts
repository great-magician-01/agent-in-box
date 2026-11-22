import type { HttpClient, HttpResponse, WsConnector, WsSocket } from "@agent-in-box/bot-connector";
import { DefaultWsConnector } from "@agent-in-box/bot-connector";
import { fetchSafeOutbound, fixedDnsLookup, resolveSafeOutboundUrl } from "../security/outbound";

const MAX_BOT_RESPONSE_BYTES = 2 * 1024 * 1024;

async function readBounded(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BOT_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("bot HTTP response exceeds the size limit");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * HTTP client for bot adapters. Every request is resolved and classified by the
 * SSRF barrier, then the actual connection is pinned to those addresses so a
 * second DNS answer cannot redirect the request (and its token) elsewhere.
 */
export const safeBotHttpClient: HttpClient = async (request) => {
  const init: RequestInit = {
    method: request.method,
    redirect: "error",
    signal: request.signal
      ? AbortSignal.any([request.signal, AbortSignal.timeout(20_000)])
      : AbortSignal.timeout(20_000),
  };
  if (request.headers) init.headers = request.headers;
  if (request.body !== undefined) init.body = request.body;
  const response = await fetchSafeOutbound(request.url, init, { allowLoopback: true });
  const result: HttpResponse = { status: response.status, body: await readBounded(response) };
  return result;
};

/**
 * WebSocket connector for the QQ gateway. Production requires WSS; plain WS is
 * accepted only for loopback test endpoints. The validated address list is
 * pinned through the same lookup the HTTP client uses.
 */
export const safeBotWsConnector: WsConnector = {
  async connect(url, options = {}): Promise<WsSocket> {
    const verified = await resolveSafeOutboundUrl(url, { allowLoopback: true });
    const isLoopback = ["127.0.0.1", "localhost", "::1"].includes(
      verified.url.hostname.replace(/^\[|\]$/g, "").toLowerCase(),
    );
    if (verified.url.protocol !== "wss:" && !(verified.url.protocol === "ws:" && isLoopback)) {
      throw new Error("机器人 WebSocket 只允许安全 WSS（回环测试地址除外）");
    }
    const hostname = verified.url.hostname.replace(/^\[|\]$/g, "");
    return new DefaultWsConnector().connect(url, {
      ...options,
      lookup: fixedDnsLookup(verified.addresses),
      ...(verified.url.protocol === "wss:" ? { servername: hostname } : {}),
    });
  },
};
