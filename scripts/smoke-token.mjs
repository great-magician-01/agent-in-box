import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";

/**
 * Writes a token file with an ACL the Go securefile package accepts.
 *
 * On Windows a plain write inherits Authenticated Users / Users access, which
 * the production Guest Agent and VM Supervisor correctly refuse. Smoke tests
 * must therefore create the same protected ACL that the installers create.
 */
export async function writeSmokeToken(file, value) {
  await writeFile(file, value, { mode: 0o600 });
  protectSmokeFile(file);
}

export function protectSmokeFile(file) {
  if (process.platform !== "win32") return;
  const user = process.env.USERNAME?.trim();
  if (!user) throw new Error("USERNAME is required to protect a smoke token file");
  const domain = process.env.USERDOMAIN?.trim();
  const principal = domain ? `${domain}\\${user}` : user;
  const result = spawnSync("icacls", [file, "/inheritance:r", "/grant:r", `${principal}:F`], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(
      `icacls failed for ${file}: ${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
    );
  }
}
