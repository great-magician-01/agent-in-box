/**
 * Phase 12 log/diagnostics redaction. Both structured values and free-form log
 * lines can contain access keys, provider keys, bot secrets or session cookies.
 * Redaction is intentionally conservative: false positives are safer than
 * leaking a credential into a diagnostics bundle.
 */

const SECRET_KEY =
  /(secret|token|passwd|password|api[_-]?key|authorization|credential|cookie|access[_-]?key|private[_-]?key)/i;

const TEXT_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\baib_[A-Za-z0-9_-]{16,}\b/g, replacement: "[REDACTED_ACCESS_KEY]" },
  {
    pattern: /\bsk-ant-[A-Za-z0-9_-]{8,}\b/g,
    replacement: "[REDACTED_API_KEY]",
  },
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g, replacement: "[REDACTED_API_KEY]" },
  {
    pattern: /\b(Bearer|QQBot)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replacement: "$1 [REDACTED]",
  },
  {
    pattern: /([?&](?:access_token|refresh_token|token|key|secret|code|ticket)=)[^&\s]+/gi,
    replacement: "$1[REDACTED]",
  },
  {
    pattern:
      /((?:"|')?(?:api[_-]?key|app[_-]?secret|app[_-]?id|secret|token|authorization|password|passwd|credential|cookie|access[_-]?key|private[_-]?key)(?:"|')?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
    replacement: "$1[REDACTED]",
  },
  {
    pattern:
      /((?:otp|one[- ]time[- ]code|verification[_-]?code|验证码|动态码|校验码)\s*[:=：]\s*)([A-Za-z0-9_-]{4,})/gi,
    replacement: "$1[REDACTED]",
  },
  { pattern: /(aib_session=)[^;\s]+/gi, replacement: "$1[REDACTED]" },
];

const MAX_STRING_LENGTH = 4000;
const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 200;

export function redactText(raw: string): string {
  let text = raw;
  for (const { pattern, replacement } of TEXT_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text.length > MAX_STRING_LENGTH ? `${text.slice(0, MAX_STRING_LENGTH)}…` : text;
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) {
    return "[depth-limit]";
  }
  if (typeof value === "string") {
    return redactText(value);
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => redactValue(item, depth + 1));
  }
  if (typeof value === "object" && value !== null) {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = SECRET_KEY.test(key) ? "[REDACTED]" : redactValue(entry, depth + 1);
    }
    return output;
  }
  return value;
}

export function redactErrorText(error: unknown): string {
  return redactText(error instanceof Error ? error.message : String(error));
}
