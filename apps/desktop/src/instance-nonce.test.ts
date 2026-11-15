import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadOrCreateInstanceNonce } from "./instance-nonce";

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-in-box-nonce-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("instance nonce", () => {
  it("creates a stable nonce and reuses it", () => {
    const file = path.join(temporaryDirectory(), "instance.nonce");
    const first = loadOrCreateInstanceNonce(file);
    const second = loadOrCreateInstanceNonce(file);
    expect(first).toMatch(/^[A-Za-z0-9_-]{32,128}$/);
    expect(second).toBe(first);
  });

  it("replaces an invalid nonce instead of trusting it", () => {
    const file = path.join(temporaryDirectory(), "instance.nonce");
    fs.writeFileSync(file, "too-short");
    const nonce = loadOrCreateInstanceNonce(file);
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{32,128}$/);
    expect(fs.readFileSync(file, "utf8").trim()).toBe(nonce);
  });
});
