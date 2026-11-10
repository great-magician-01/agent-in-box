/**
 * Logging helpers for bot connectors.
 *
 * Bot credentials (app secret, client secret, access tokens) must never be
 * written to ordinary logs. Callers should pass a logger that redacts values
 * it receives, but this module also redacts common secret shapes defensively.
 */

export type BotLogFields = Readonly<Record<string, unknown>>;

export interface BotConnectorLogger {
  debug(message: string, fields?: BotLogFields): void;
  info(message: string, fields?: BotLogFields): void;
  warn(message: string, fields?: BotLogFields): void;
  error(message: string, fields?: BotLogFields): void;
}

export const NOOP_BOT_LOGGER: BotConnectorLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const BEARER_PATTERN = /\b(Bearer|QQBot)\s+[A-Za-z0-9._~+/=-]+/gi;
const SECRET_FIELD_PATTERN =
  /("?(?:app[_-]?secret|client[_-]?secret|access[_-]?token|appSecret|clientSecret|tenant_access_token)"?\s*[:=]\s*)"?[^",}\s]+"?/gi;

/** Removes credential-looking fragments from text before it reaches logs or status. */
export function redactSecrets(text: string): string {
  return text
    .replace(BEARER_PATTERN, "$1 [REDACTED]")
    .replace(SECRET_FIELD_PATTERN, "$1[REDACTED]");
}

/** Removes exact credential values that a platform/SDK error may echo verbatim. */
export function redactSecretValues(text: string, values: readonly string[]): string {
  let redacted = redactSecrets(text);
  for (const value of values) {
    if (value) {
      redacted = redacted.split(value).join("[REDACTED]");
    }
  }
  return redacted;
}

/** Converts an unknown thrown value into a bounded, redacted status message. */
export function safeErrorMessage(error: unknown): string {
  const raw =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : typeof error === "string"
        ? error
        : "unknown error";
  const redacted = redactSecrets(raw).replace(/\s+/g, " ").trim();
  return redacted.length > 500 ? `${redacted.slice(0, 500)}...` : redacted;
}
