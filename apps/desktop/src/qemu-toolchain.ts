import { createHash } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { QemuToolchainStatus } from "@agent-in-box/protocol";
import type { LoggerLike } from "./logger";

const DEFAULT_MANIFEST_URL =
  "https://github.com/great-magician-01/agent-in-box/releases/latest/download/runtime-assets.json";
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;

export interface QemuRuntimeAsset {
  version: string;
  url: string;
  sha256: string;
  sizeBytes: number;
}

export interface RuntimeAssetsManifest {
  qemu?: Record<string, QemuRuntimeAsset>;
}

interface QemuConfigFile {
  customPath?: string | null;
  installedVersion?: string | null;
  manifestUrl?: string | null;
}

export interface QemuToolchainOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  dataRoot: string;
  configPath: string;
  env?: NodeJS.ProcessEnv;
  logger: LoggerLike;
  fetchImpl?: typeof fetch;
  spawn?: typeof spawnSync;
}

export class QemuToolchainManager {
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private dataRoot: string;
  private readonly configPath: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly logger: LoggerLike;
  private readonly fetchImpl: typeof fetch;
  private readonly spawn: typeof spawnSync;

  constructor(options: QemuToolchainOptions) {
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.dataRoot = path.resolve(options.dataRoot);
    this.configPath = options.configPath;
    this.env = options.env ?? process.env;
    this.logger = options.logger;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.spawn = options.spawn ?? spawnSync;
  }

  get managedRoot(): string {
    return path.join(this.dataRoot, "tools", "qemu");
  }

  setDataRoot(root: string): void {
    this.dataRoot = path.resolve(root);
  }

  async status(): Promise<QemuToolchainStatus> {
    const config = await this.readConfig();
    const custom = config.customPath?.trim();
    if (custom) {
      const resolved = await this.validateDir(custom);
      if (resolved) {
        return {
          state: "custom",
          path: resolved,
          version: config.installedVersion ?? null,
          message: null,
          managedRoot: this.managedRoot,
        };
      }
      return {
        state: "invalid",
        path: custom,
        version: null,
        message: "配置的 QEMU 目录缺少 qemu-system-x86_64/qemu-img",
        managedRoot: this.managedRoot,
      };
    }
    const managed = await this.findManaged();
    if (managed) {
      return {
        state: "managed",
        path: managed.path,
        version: managed.version,
        message: null,
        managedRoot: this.managedRoot,
      };
    }
    const system = await this.findSystem();
    if (system) {
      return {
        state: "system",
        path: system,
        version: null,
        message: null,
        managedRoot: this.managedRoot,
      };
    }
    return {
      state: "missing",
      path: null,
      version: null,
      message: "未找到 QEMU。可以使用应用内下载或手动选择安装目录。",
      managedRoot: this.managedRoot,
    };
  }

  async setCustomPath(input: string | null): Promise<QemuToolchainStatus> {
    const config = await this.readConfig();
    if (!input?.trim()) {
      config.customPath = null;
    } else {
      const resolved = path.resolve(input.trim());
      if (!(await this.validateDir(resolved))) {
        throw new Error(
          "所选目录不是有效的 QEMU 工具链（需要 bin/qemu-system-x86_64 与 bin/qemu-img）",
        );
      }
      config.customPath = resolved;
    }
    await this.writeConfig(config);
    return this.status();
  }

  async install(): Promise<QemuToolchainStatus> {
    const manifest = await this.fetchManifest();
    const key = this.assetKey();
    const asset = manifest.qemu?.[key];
    if (!asset) {
      throw new Error(`运行时 Manifest 不包含 ${key} 的 QEMU 工具链`);
    }
    validateAsset(asset);
    const versionDir = path.join(this.managedRoot, sanitizeVersion(asset.version));
    if (await this.validateDir(versionDir)) {
      return this.status();
    }
    const downloads = path.join(this.dataRoot, "downloads", "runtime");
    await fs.mkdir(downloads, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.managedRoot, { recursive: true, mode: 0o700 });
    const archive = path.join(
      downloads,
      `qemu-${key}-${sanitizeVersion(asset.version)}.tar.gz.partial`,
    );
    try {
      await this.downloadVerified(asset, archive);
      const staging = await fs.mkdtemp(path.join(this.managedRoot, ".install-"));
      try {
        this.assertSafeArchive(archive);
        const result = this.spawn("tar", ["-xzf", archive, "-C", staging], {
          stdio: "ignore",
          windowsHide: true,
        });
        if (result.status !== 0) {
          throw new Error("QEMU 工具链解压失败");
        }
        const extracted = await this.detectLayout(staging);
        if (!extracted) {
          throw new Error("QEMU 工具链归档缺少 bin/ 与 share/qemu/ 目录");
        }
        await fs.rm(versionDir, { recursive: true, force: true });
        await fs.rename(extracted, versionDir);
        await fs.writeFile(
          path.join(versionDir, "agent-in-box-qemu.json"),
          `${JSON.stringify({ ...asset, installedAt: new Date().toISOString() }, null, 2)}\n`,
          { mode: 0o600 },
        );
      } finally {
        await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      }
      const config = await this.readConfig();
      config.customPath = null;
      config.installedVersion = asset.version;
      await this.writeConfig(config);
      return this.status();
    } finally {
      await fs.rm(archive, { force: true }).catch(() => undefined);
    }
  }

  private async readConfig(): Promise<QemuConfigFile> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.configPath, "utf8")) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as QemuConfigFile;
      }
    } catch {
      // Missing or corrupt config is treated as no override.
    }
    return {};
  }

  private async writeConfig(config: QemuConfigFile): Promise<void> {
    await fs.mkdir(path.dirname(this.configPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.configPath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, this.configPath);
  }

  private assetKey(): string {
    const arch = this.arch === "arm64" ? "arm64" : "x64";
    return `${this.platform === "win32" ? "windows" : this.platform === "darwin" ? "darwin" : "linux"}-${arch}`;
  }

  private manifestUrl(): string {
    return this.env.AGENT_IN_BOX_RUNTIME_MANIFEST?.trim() || DEFAULT_MANIFEST_URL;
  }

  private async fetchManifest(): Promise<RuntimeAssetsManifest> {
    const url = this.manifestUrl();
    const response = await this.fetchChecked(url, AbortSignal.timeout(30_000));
    if (!response.ok) throw new Error(`下载运行时 Manifest 失败：HTTP ${response.status}`);
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES) {
      throw new Error("运行时 Manifest 过大");
    }
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("运行时 Manifest 格式无效");
    }
    return parsed as RuntimeAssetsManifest;
  }

  private async downloadVerified(asset: QemuRuntimeAsset, target: string): Promise<void> {
    const response = await this.fetchChecked(asset.url, AbortSignal.timeout(30 * 60_000));
    if (!response.ok || !response.body) {
      throw new Error(`下载 QEMU 工具链失败：HTTP ${response.status}`);
    }
    const hash = createHash("sha256");
    let bytes = 0;
    const source = Readable.fromWeb(response.body as never);
    const sink = createWriteStream(target, { mode: 0o600 });
    await pipeline(
      source,
      async function* (stream: AsyncIterable<Buffer>) {
        for await (const chunk of stream) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.byteLength;
          if (bytes > MAX_ARCHIVE_BYTES) throw new Error("QEMU 工具链归档超过大小上限");
          hash.update(buffer);
          yield buffer;
        }
      },
      sink,
    );
    if (bytes !== asset.sizeBytes) {
      await fs.rm(target, { force: true });
      throw new Error(`QEMU 工具链大小校验失败（期望 ${asset.sizeBytes}，实际 ${bytes}）`);
    }
    const actual = hash.digest("hex");
    if (actual !== asset.sha256.toLowerCase()) {
      await fs.rm(target, { force: true });
      throw new Error("QEMU 工具链 SHA-256 校验失败");
    }
    this.logger.info("QEMU 工具链下载并校验完成", { version: asset.version, bytes });
  }

  private async fetchChecked(url: string, signal: AbortSignal): Promise<Response> {
    let current = url;
    for (let hop = 0; hop < 6; hop += 1) {
      assertHttpsOrLoopback(current);
      const response = await this.fetchImpl(current, { signal, redirect: "manual" });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error("运行时资产重定向缺少 Location");
        current = new URL(location, current).toString();
        continue;
      }
      return response;
    }
    throw new Error("运行时资产重定向次数过多");
  }

  private assertSafeArchive(archive: string): void {
    const listed = this.spawn("tar", ["-tzf", archive], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    if (listed.status !== 0 || typeof listed.stdout !== "string") {
      throw new Error("QEMU 工具链归档无法读取");
    }
    for (const raw of listed.stdout.split(/\r?\n/)) {
      const entry = raw.trim();
      if (!entry) continue;
      if (
        path.posix.isAbsolute(entry) ||
        entry.split("/").includes("..") ||
        /^[A-Za-z]:/.test(entry)
      ) {
        throw new Error(`QEMU 工具链归档包含不安全路径：${entry}`);
      }
    }
  }

  private async detectLayout(directory: string): Promise<string | null> {
    if (await this.hasBinaries(directory)) return directory;
    if (await this.hasBinaries(path.join(directory, "bin"))) return directory;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const candidate = path.join(directory, entry.name);
      if (await this.hasBinaries(candidate)) return candidate;
      if (await this.hasBinaries(path.join(candidate, "bin"))) return candidate;
    }
    return null;
  }

  private async validateDir(directory: string): Promise<string | null> {
    const resolved = path.resolve(directory);
    if (await this.hasBinaries(resolved)) return resolved;
    if (await this.hasBinaries(path.join(resolved, "bin"))) {
      return path.join(resolved, "bin");
    }
    return null;
  }

  private async hasBinaries(directory: string): Promise<boolean> {
    const suffix = this.platform === "win32" ? ".exe" : "";
    return (
      (await existsFile(path.join(directory, `qemu-system-x86_64${suffix}`))) &&
      (await existsFile(path.join(directory, `qemu-img${suffix}`)))
    );
  }

  private async findManaged(): Promise<{ path: string; version: string } | null> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.managedRoot);
    } catch {
      return null;
    }
    const candidates = await Promise.all(
      entries
        .filter((entry) => !entry.startsWith("."))
        .map(async (entry) => {
          const directory = path.join(this.managedRoot, entry);
          const bin = path.join(directory, "bin");
          return (await this.hasBinaries(bin)) ? { path: bin, version: entry } : null;
        }),
    );
    return (
      candidates
        .filter((item): item is { path: string; version: string } => item !== null)
        .at(-1) ?? null
    );
  }

  private async findSystem(): Promise<string | null> {
    const candidates =
      this.platform === "win32"
        ? [
            path.join(
              this.env.LOCALAPPDATA ?? "",
              "AgentInBox",
              "tools",
              "msys64",
              "ucrt64",
              "bin",
            ),
            "C:\\msys64\\ucrt64\\bin",
            "C:\\msys64\\mingw64\\bin",
            "C:\\Program Files\\qemu",
          ]
        : this.platform === "darwin"
          ? ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
          : ["/usr/bin", "/usr/local/bin"];
    for (const candidate of candidates) {
      if (candidate && (await this.hasBinaries(candidate))) return candidate;
    }
    return null;
  }
}

async function existsFile(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

function sanitizeVersion(version: string): string {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(version)) {
    throw new Error("QEMU 工具链版本号不安全");
  }
  return version;
}

function validateAsset(asset: QemuRuntimeAsset): void {
  if (
    typeof asset.version !== "string" ||
    typeof asset.url !== "string" ||
    typeof asset.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/i.test(asset.sha256) ||
    !Number.isSafeInteger(asset.sizeBytes) ||
    asset.sizeBytes < 1 ||
    asset.sizeBytes > MAX_ARCHIVE_BYTES
  ) {
    throw new Error("QEMU 运行时资产字段无效");
  }
  assertHttpsOrLoopback(asset.url);
}

function assertHttpsOrLoopback(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("运行时资产 URL 无效");
  }
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname.replace(/^\[|\]$/g, ""));
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("运行时资产只允许 HTTPS；仅回环地址允许 HTTP");
  }
  if (url.username || url.password) throw new Error("运行时资产 URL 不能包含凭据");
}
