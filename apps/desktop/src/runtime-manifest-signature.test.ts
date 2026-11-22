import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { signedPayload, verifySignature } from "./signature";

const repository = path.resolve(import.meta.dirname, "..", "..", "..");

describe("runtime asset manifest signing", () => {
  it("matches the desktop verifier and rejects cross-purpose signatures", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "aib-runtime-signature-"));
    try {
      const keys = generateKeyPairSync("ed25519");
      const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
      const privateKeyPath = path.join(directory, "signing-key.pem");
      writeFileSync(
        privateKeyPath,
        keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        { mode: 0o600 },
      );
      const manifest = {
        schemaVersion: 1,
        qemu: {
          "windows-x64": {
            version: "11.1.3",
            url: "https://example.test/qemu.tar.gz",
            sha256: "a".repeat(64),
            sizeBytes: 1024,
          },
        },
      };
      const manifestPath = path.join(directory, "runtime-assets.json");
      const signedPath = path.join(directory, "runtime-assets.signed.json");
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const result = spawnSync(
        process.execPath,
        [
          path.join(repository, "scripts", "sign-runtime-assets.mjs"),
          manifestPath,
          privateKeyPath,
          signedPath,
        ],
        { encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      const signed = JSON.parse(readFileSync(signedPath, "utf8")) as typeof manifest & {
        signature: string;
      };
      const { signature, ...payload } = signed;
      expect(verifySignature("runtime-assets", payload, publicKey, signature)).toBe(true);
      expect(verifySignature("desktop-update", payload, publicKey, signature)).toBe(false);

      // The script must refuse a manifest that already has a signature.
      const second = spawnSync(
        process.execPath,
        [
          path.join(repository, "scripts", "sign-runtime-assets.mjs"),
          signedPath,
          privateKeyPath,
          path.join(directory, "second.json"),
        ],
        { encoding: "utf8" },
      );
      expect(second.status).not.toBe(0);

      // A hand-made signature over a different payload must fail verification.
      const forged = sign(
        null,
        signedPayload("runtime-assets", { ...payload, schemaVersion: 2 }),
        keys.privateKey,
      ).toString("base64");
      expect(verifySignature("runtime-assets", payload, publicKey, forged)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
