import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CredentialStore, type SafeStoragePort } from "./credential-store";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "agent-in-box-credentials-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fakeSafeStorage(
  overrides: Partial<SafeStoragePort> & { backend?: string } = {},
): SafeStoragePort {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => overrides.backend ?? "dpapi",
    encryptString: (value) => Buffer.from(`encrypted:${value}`, "utf8"),
    decryptString: (value) => value.toString("utf8").replace(/^encrypted:/, ""),
    ...overrides,
  };
}

describe("credential store", () => {
  it("stores only ciphertext and never exposes the secret", () => {
    const directory = temporaryDirectory();
    const file = path.join(directory, "credentials.json");
    const store = new CredentialStore({
      filePath: file,
      safeStorage: fakeSafeStorage(),
      platform: "win32",
      now: () => new Date("2026-11-10T00:00:00.000Z"),
    });

    const status = store.save({ providerId: "anthropic", secret: "sk-ant-secret-value" });

    expect(status.secureStorageAvailable).toBe(true);
    expect(status.providers).toEqual([
      { providerId: "anthropic", updatedAt: "2026-11-10T00:00:00.000Z" },
    ]);
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain("sk-ant-secret-value");
    expect(JSON.parse(raw).credentials.anthropic.ciphertext).toBe(
      Buffer.from("encrypted:sk-ant-secret-value").toString("base64"),
    );
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(store.decrypt("anthropic")).toBe("sk-ant-secret-value");
    expect(store.decrypt("missing")).toBeNull();
  });

  it("removes credentials", () => {
    const directory = temporaryDirectory();
    const file = path.join(directory, "credentials.json");
    const store = new CredentialStore({
      filePath: file,
      safeStorage: fakeSafeStorage(),
      platform: "win32",
    });
    store.save({ providerId: "anthropic", secret: "sk-ant-secret-value" });

    const status = store.remove("anthropic");
    expect(status.providers).toEqual([]);
    expect(store.decrypt("anthropic")).toBeNull();
  });

  it("refuses to save when safeStorage only offers basic_text", () => {
    const directory = temporaryDirectory();
    const store = new CredentialStore({
      filePath: path.join(directory, "credentials.json"),
      safeStorage: fakeSafeStorage({ backend: "basic_text" }),
      platform: "linux",
    });

    const status = store.status();
    expect(status.secureStorageAvailable).toBe(false);
    expect(status.message).toContain("basic_text");
    expect(() => store.save({ providerId: "anthropic", secret: "sk-ant-secret-value" })).toThrow(
      "basic_text",
    );
  });

  it("refuses to save when encryption is unavailable", () => {
    const directory = temporaryDirectory();
    const store = new CredentialStore({
      filePath: path.join(directory, "credentials.json"),
      safeStorage: fakeSafeStorage({ isEncryptionAvailable: () => false }),
      platform: "win32",
    });

    expect(store.status().secureStorageAvailable).toBe(false);
    expect(() => store.save({ providerId: "anthropic", secret: "sk-ant-secret-value" })).toThrow();
  });

  it("validates provider ids and secret lengths", () => {
    const directory = temporaryDirectory();
    const store = new CredentialStore({
      filePath: path.join(directory, "credentials.json"),
      safeStorage: fakeSafeStorage(),
      platform: "win32",
    });

    expect(() => store.save({ providerId: "../escape", secret: "long-enough" })).toThrow(
      "Provider",
    );
    expect(() => store.save({ providerId: "anthropic", secret: "short" })).toThrow("长度");
  });
});
