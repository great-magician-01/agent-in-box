/** Minimal injectable HTTP surface so adapters can be tested without public network access. */

export type HttpMethod = "GET" | "POST";

export interface HttpRequest {
  url: string;
  method: HttpMethod;
  headers?: Readonly<Record<string, string>>;
  body?: string;
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  body: string;
}

export type HttpClient = (request: HttpRequest) => Promise<HttpResponse>;

/** Default HTTP client built on Node's global fetch (Node >= 22). */
export const fetchHttpClient: HttpClient = async (request) => {
  const init: RequestInit = {
    method: request.method,
    // Bot tokens are placed in JSON bodies; never let a redirect replay them
    // to another host.
    redirect: "error",
    signal: request.signal
      ? AbortSignal.any([request.signal, AbortSignal.timeout(20_000)])
      : AbortSignal.timeout(20_000),
  };
  if (request.headers) {
    init.headers = request.headers;
  }
  if (request.body !== undefined) {
    init.body = request.body;
  }
  const response = await fetch(request.url, init);
  return { status: response.status, body: await readTextLimited(response, 2 * 1024 * 1024) };
};

async function readTextLimited(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("bot HTTP response exceeds the size limit");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
