import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QemuToolchainManager } from "./qemu-toolchain";

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => logger,
};

let root: string;
let dataRoot: string;
let configPath: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "agent-in-box-qemu-"));
  dataRoot = path.join(root, "data");
  configPath = path.join(root, "config", "qemu-runtime.json");
  await mkdir(dataRoot, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function manager(fetchImpl?: typeof fetch): QemuToolchainManager {
  return new QemuToolchainManager({
    platform: "linux",
    arch: "x64",
    dataRoot,
    configPath,
    logger,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

async function makeBinDirectory(directory: string): Promise<void> {
  await mkdir(path.join(directory, "bin"), { recursive: true });
  await writeFile(path.join(directory, "bin", "qemu-system-x86_64"), "system");
  await writeFile(path.join(directory, "bin", "qemu-img"), "img");
  await mkdir(path.join(directory, "share", "qemu"), { recursive: true });
  await writeFile(path.join(directory, "share", "qemu", "keymaps"), "keymaps");
}

describe("QemuToolchainManager", () => {
  it("reports missing, custom and managed toolchains", async () => {
    const toolchain = manager();
    await expect(toolchain.status()).resolves.toMatchObject({ state: "missing" });

    const custom = path.join(root, "custom-qemu");
    await makeBinDirectory(custom);
    await expect(toolchain.setCustomPath(custom)).resolves.toMatchObject({
      state: "custom",
      path: path.join(custom, "bin"),
    });

    await toolchain.setCustomPath(null);
    const managed = path.join(dataRoot, "tools", "qemu", "11.1.3");
    await makeBinDirectory(managed);
    await expect(toolchain.status()).resolves.toMatchObject({
      state: "managed",
      version: "11.1.3",
    });
  });

  it("downloads, verifies and atomically installs a managed toolchain", async () => {
    const staging = path.join(root, "package");
    await makeBinDirectory(staging);
    const archive = path.join(root, "qemu.tar.gz");
    const tar = spawnSync(
      "tar",
      [
        "-czf",
        path.relative(root, archive).split(path.sep).join("/"),
        "-C",
        path.relative(root, staging).split(path.sep).join("/"),
        ".",
      ],
      { cwd: root, stdio: "ignore" },
    );
    expect(tar.status).toBe(0);
    const bytes = await readFile(archive);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const manifest = {
      qemu: {
        "linux-x64": {
          version: "11.1.3",
          url: "https://assets.example.test/qemu.tar.gz",
          sha256,
          sizeBytes: bytes.byteLength,
        },
      },
    };
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("runtime-assets.json")) {
        return new Response(JSON.stringify(manifest), { status: 200 });
      }
      return new Response(bytes, { status: 200 });
    }) as typeof fetch;
    const toolchain = new QemuToolchainManager({
      platform: "linux",
      arch: "x64",
      dataRoot,
      configPath,
      logger,
      fetchImpl,
      env: { AGENT_IN_BOX_RUNTIME_MANIFEST: "https://assets.example.test/runtime-assets.json" },
    });
    await expect(toolchain.install()).resolves.toMatchObject({
      state: "managed",
      version: "11.1.3",
      path: path.join(dataRoot, "tools", "qemu", "11.1.3", "bin"),
    });
    await expect(
      readFile(path.join(dataRoot, "tools", "qemu", "11.1.3", "bin", "qemu-img"), "utf8"),
    ).resolves.toBe("img");
  });

  it("rejects an archive whose SHA-256 does not match", async () => {
    const bytes = Buffer.from("not the expected archive");
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("runtime-assets.json")) {
        return new Response(
          JSON.stringify({
            qemu: {
              "linux-x64": {
                version: "11.1.3",
                url: "https://assets.example.test/qemu.tar.gz",
                sha256: "0".repeat(64),
                sizeBytes: bytes.byteLength,
              },
            },
          }),
          { status: 200 },
        );
      }
      return new Response(bytes, { status: 200 });
    }) as typeof fetch;
    const toolchain = new QemuToolchainManager({
      platform: "linux",
      arch: "x64",
      dataRoot,
      configPath,
      logger,
      fetchImpl,
      env: { AGENT_IN_BOX_RUNTIME_MANIFEST: "https://assets.example.test/runtime-assets.json" },
    });
    await expect(toolchain.install()).rejects.toThrow(/SHA-256/);
  });

  it("verifies a signed runtime manifest and rejects a wrong purpose signature", async () => {
    const { generateKeyPairSync, sign } = await import("node:crypto");
    const { signedPayload } = await import("./signature");
    const keys = generateKeyPairSync("ed25519");
    const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const manifest = {
      qemu: {
        "linux-x64": {
          version: "11.1.3",
          url: "https://assets.example.test/qemu.tar.gz",
          sha256: "0".repeat(64),
          sizeBytes: 1,
        },
      },
    };
    const signatureFor = (purpose: "runtime-assets" | "desktop-update") =>
      sign(null, signedPayload(purpose, manifest), keys.privateKey).toString("base64");

    const fetchSigned = (signature: string) =>
      (async () =>
        new Response(JSON.stringify({ ...manifest, signature }), { status: 200 })) as typeof fetch;

    const accepted = new QemuToolchainManager({
      platform: "linux",
      arch: "x64",
      dataRoot,
      configPath,
      logger,
      publicKey,
      requireSignature: true,
      fetchImpl: fetchSigned(signatureFor("runtime-assets")),
      env: { AGENT_IN_BOX_RUNTIME_MANIFEST: "https://assets.example.test/runtime-assets.json" },
    });
    // The manifest is authentic but the archive bytes are bogus, so verification
    // must fail at the SHA-256 stage rather than at signature verification.
    await expect(accepted.install()).rejects.toThrow(/SHA-256|大小校验|HTTP/);

    const wrongPurpose = new QemuToolchainManager({
      platform: "linux",
      arch: "x64",
      dataRoot,
      configPath,
      logger,
      publicKey,
      requireSignature: true,
      fetchImpl: fetchSigned(signatureFor("desktop-update")),
      env: { AGENT_IN_BOX_RUNTIME_MANIFEST: "https://assets.example.test/runtime-assets.json" },
    });
    await expect(wrongPurpose.install()).rejects.toThrow("签名校验失败");

    const unsigned = new QemuToolchainManager({
      platform: "linux",
      arch: "x64",
      dataRoot,
      configPath,
      logger,
      publicKey,
      requireSignature: true,
      fetchImpl: (async () =>
        new Response(JSON.stringify(manifest), { status: 200 })) as typeof fetch,
      env: { AGENT_IN_BOX_RUNTIME_MANIFEST: "https://assets.example.test/runtime-assets.json" },
    });
    await expect(unsigned.install()).rejects.toThrow("缺少有效签名");

    const noKey = new QemuToolchainManager({
      platform: "linux",
      arch: "x64",
      dataRoot,
      configPath,
      logger,
      requireSignature: true,
      fetchImpl: (async () =>
        new Response(JSON.stringify(manifest), { status: 200 })) as typeof fetch,
      env: { AGENT_IN_BOX_RUNTIME_MANIFEST: "https://assets.example.test/runtime-assets.json" },
    });
    await expect(noKey.install()).rejects.toThrow("必须配置运行时 Manifest 公钥");
  });

  it("rejects archives that contain links or special files", async () => {
    const bytes = Buffer.from("archive");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const manifest = {
      qemu: {
        "linux-x64": {
          version: "11.1.3",
          url: "https://assets.example.test/qemu.tar.gz",
          sha256,
          sizeBytes: bytes.byteLength,
        },
      },
    };
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("runtime-assets.json")) {
        return new Response(JSON.stringify(manifest), { status: 200 });
      }
      return new Response(bytes, { status: 200 });
    }) as typeof fetch;
    const fakeSpawn = ((_command: string, args: string[]) => {
      if (args[0] === "-tzf") {
        return {
          status: 0,
          stdout:
            "bin/qemu-system-x86_64" +
            String.fromCharCode(10) +
            "bin/qemu-img" +
            String.fromCharCode(10),
          stderr: "",
        };
      }
      return {
        status: 0,
        stdout:
          "lrwxrwxrwx qemu/qemu 0 2026-01-01 00:00 bin/qemu-system-x86_64 -> /bin/sh" +
          String.fromCharCode(10),
        stderr: "",
      };
    }) as unknown as typeof spawnSync;
    const toolchain = new QemuToolchainManager({
      platform: "linux",
      arch: "x64",
      dataRoot,
      configPath,
      logger,
      fetchImpl,
      spawn: fakeSpawn,
      env: { AGENT_IN_BOX_RUNTIME_MANIFEST: "https://assets.example.test/runtime-assets.json" },
    });
    await expect(toolchain.install()).rejects.toThrow("链接或特殊文件");
  });
});
