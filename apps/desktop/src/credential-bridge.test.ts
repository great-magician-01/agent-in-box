import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CredentialBridge } from "./credential-bridge";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("CredentialBridge", () => {
  it("decrypts only for an authenticated local request and removes its descriptor", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "aib-credential-bridge-"));
    directories.push(directory);
    const descriptorPath = path.join(directory, "credential-bridge.json");
    const bridge = new CredentialBridge({
      descriptorPath,
      credentialStore: {
        decrypt: (kind, providerId) =>
          kind === "model" && providerId === "anthropic" ? "sk-ant-secret" : null,
      },
    });
    await bridge.start();
    const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8")) as {
      url: string;
      token: string;
    };
    if (process.platform !== "win32") {
      expect(statSync(descriptorPath).mode & 0o777).toBe(0o600);
    }

    const unauthorized = await fetch(`${descriptor.url}/v1/decrypt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: "anthropic" }),
    });
    expect(unauthorized.status).toBe(401);
    await unauthorized.arrayBuffer();

    const allowed = await fetch(`${descriptor.url}/v1/decrypt`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${descriptor.token}`,
      },
      body: JSON.stringify({ kind: "model", providerId: "anthropic" }),
    });
    expect(allowed.status).toBe(200);
    await expect(allowed.json()).resolves.toEqual({ secret: "sk-ant-secret" });

    const missing = await fetch(`${descriptor.url}/v1/decrypt`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${descriptor.token}`,
      },
      body: JSON.stringify({ kind: "model", providerId: "missing" }),
    });
    expect(missing.status).toBe(404);
    await missing.arrayBuffer();

    bridge.stop();
    expect(() => readFileSync(descriptorPath, "utf8")).toThrow();
  });
});
