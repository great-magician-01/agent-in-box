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
  const init: RequestInit = { method: request.method };
  if (request.headers) {
    init.headers = request.headers;
  }
  if (request.body !== undefined) {
    init.body = request.body;
  }
  if (request.signal) {
    init.signal = request.signal;
  }
  const response = await fetch(request.url, init);
  return { status: response.status, body: await response.text() };
};

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
