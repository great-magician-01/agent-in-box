import fs from "node:fs";
import path from "node:path";

/**
 * Phase 11 introduced mandatory local authentication. Smoke tests use the
 * control plane's persisted access key as an explicit Bearer credential; the
 * key is never printed, logged or committed.
 */
export function smokeAccessKey(configDirectory, timeoutMs = 20_000) {
  const file = path.join(configDirectory, "web-access-key");
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = fs.readFileSync(file, "utf8").trim();
      if (value.length >= 32) return value;
    } catch (error) {
      lastError = error;
    }
    const waitUntil = Date.now() + 50;
    while (Date.now() < waitUntil) {
      // synchronous sleep is acceptable while waiting for a child process
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  throw new Error(`access key file unavailable: ${file} (${String(lastError ?? "")})`);
}

export function smokeAuthHeaders(configDirectory, extra = {}) {
  return {
    authorization: `Bearer ${smokeAccessKey(configDirectory)}`,
    ...extra,
  };
}
