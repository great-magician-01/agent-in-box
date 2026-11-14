import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

const NONCE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

/**
 * Returns the installation's long-lived instance nonce, creating it on first
 * use. Both the desktop shell and the processes it spawns use this value to
 * prove they belong to the same installation before any secret is handed over.
 *
 * The nonce is deliberately persisted: after an Electron crash the control
 * plane may still be running, and the desktop must be able to recognise its
 * own child instead of trusting an arbitrary process on the fixed port.
 */
export function loadOrCreateInstanceNonce(filePath: string): string {
  try {
    const existing = fs.readFileSync(filePath, "utf8").trim();
    if (NONCE_PATTERN.test(existing)) {
      return existing;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(
        `无法读取实例 nonce：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const nonce = randomBytes(32).toString("base64url");
  const directory = path.dirname(path.resolve(filePath));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.instance-nonce.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temporary, `${nonce}\n`, { mode: 0o600 });
  try {
    fs.renameSync(temporary, filePath);
  } catch {
    fs.rmSync(filePath, { force: true });
    fs.renameSync(temporary, filePath);
  }
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Windows does not use POSIX modes; the parent directory ACL protects it.
  }
  return nonce;
}
