import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  DesktopUpdateRollbackView,
  DesktopUpdateState,
  DesktopUpdateStatus,
} from "@agent-in-box/protocol";

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
// Manifest versions become installer directory names. Keep the whole string
// path-safe; compareVersions only validates the numeric core before a dash.
const UPDATE_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const MAX_VERSION_LENGTH = 120;

export interface UpdateManifestFile {
  platform: "win32" | "darwin" | "linux";
  arch: "x64" | "arm64" | "ia32";
  url: string;
  sha256: string;
  sizeBytes?: number;
  installArgs?: string[];
}

export interface UpdateManifest {
  version: string;
  notes?: string;
  publishedAt?: string;
  files: UpdateManifestFile[];
}

export interface NormalizedUpdate {
  version: string;
  notes: string | null;
  publishedAt: string | null;
  url: string;
  sha256: string;
  sizeBytes: number | null;
  installArgs: string[];
}

export interface UpdateManagerOptions {
  currentVersion: string;
  platform?: NodeJS.Platform;
  arch?: string;
  directory: string;
  feedUrl: () => string | null;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  rollbackAvailable?: () => DesktopUpdateRollbackView | null;
  maxDownloadBytes?: number;
}

export interface UpdateDownloadReady {
  installerPath: string;
  version: string;
  notes: string | null;
  sha256: string;
}

export function isValidUpdateUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol === "https:") return true;
    return (
      url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost")
    );
  } catch {
    return false;
  }
}

export function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] => {
    const core = value.trim().replace(/^v/i, "").split("-")[0]!;
    const parts = core.split(".").map((part) => Number(part));
    if (parts.length === 0 || parts.some((part) => !Number.isInteger(part) || part < 0)) {
      throw new Error(`无效版本号：${value}`);
    }
    while (parts.length < 3) parts.push(0);
    return parts.slice(0, 3);
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index]! !== b[index]!) return a[index]! > b[index]! ? 1 : -1;
  }
  return 0;
}

export function parseUpdateManifest(
  raw: unknown,
  input: { platform?: NodeJS.Platform; arch?: string; currentVersion: string },
): NormalizedUpdate {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("更新 Manifest 必须是 JSON 对象");
  }
  const manifest = raw as Record<string, unknown>;
  if (typeof manifest.version !== "string") {
    throw new Error("更新 Manifest 缺少 version");
  }
  if (
    manifest.version.length > MAX_VERSION_LENGTH ||
    !UPDATE_VERSION_PATTERN.test(manifest.version)
  ) {
    throw new Error("更新 Manifest 的 version 不是安全的语义化版本号");
  }
  compareVersions(manifest.version, input.currentVersion);
  if (!Array.isArray(manifest.files)) {
    throw new Error("更新 Manifest 缺少 files");
  }
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  const file = manifest.files.find((candidate) => {
    if (typeof candidate !== "object" || candidate === null) return false;
    const item = candidate as Record<string, unknown>;
    return item.platform === platform && item.arch === arch;
  }) as Record<string, unknown> | undefined;
  if (!file) {
    throw new Error(`更新 Manifest 没有 ${platform}/${arch} 的安装包`);
  }
  if (typeof file.url !== "string" || !isValidUpdateUrl(file.url)) {
    throw new Error("更新安装包 URL 必须是 HTTPS（开发测试可使用本机回环 HTTP）");
  }
  if (typeof file.sha256 !== "string" || !SHA256_PATTERN.test(file.sha256)) {
    throw new Error("更新安装包 SHA-256 无效");
  }
  const sizeBytes =
    typeof file.sizeBytes === "number" && Number.isInteger(file.sizeBytes) && file.sizeBytes > 0
      ? file.sizeBytes
      : null;
  const installArgs = Array.isArray(file.installArgs)
    ? file.installArgs.filter((value): value is string => typeof value === "string").slice(0, 20)
    : platform === "win32"
      ? ["/S"]
      : [];
  return {
    version: manifest.version,
    notes: typeof manifest.notes === "string" ? manifest.notes.slice(0, 4000) : null,
    publishedAt: typeof manifest.publishedAt === "string" ? manifest.publishedAt : null,
    url: file.url,
    sha256: file.sha256.toLowerCase(),
    sizeBytes,
    installArgs,
  };
}

export class UpdateManager {
  private readonly options: UpdateManagerOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private state: DesktopUpdateState = "idle";
  private available: NormalizedUpdate | null = null;
  private error: string | null = null;
  private progress: number | null = null;
  private ready: UpdateDownloadReady | null = null;
  private checkedAt: string | null = null;
  private busy = false;

  constructor(options: UpdateManagerOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  status(): DesktopUpdateStatus {
    return {
      state: this.state,
      currentVersion: this.options.currentVersion,
      availableVersion: this.available?.version ?? null,
      notes: this.available?.notes ?? null,
      downloadProgress: this.progress,
      error: this.error,
      readyToInstall: this.ready !== null,
      rollbackAvailable: this.options.rollbackAvailable?.() ?? null,
      checkedAt: this.checkedAt,
    };
  }

  getReady(): UpdateDownloadReady | null {
    return this.ready;
  }

  getAvailable(): NormalizedUpdate | null {
    return this.available;
  }

  async check(): Promise<DesktopUpdateStatus> {
    if (this.busy) return this.status();
    this.busy = true;
    this.state = "checking";
    this.error = null;
    this.progress = null;
    this.ready = null;
    try {
      const feed = this.options.feedUrl();
      if (!feed) {
        throw new Error("尚未配置更新源");
      }
      if (!isValidUpdateUrl(feed)) {
        throw new Error("更新源必须是 HTTPS 地址（开发测试可使用本机回环 HTTP）");
      }
      const response = await this.fetchImpl(feed, {
        signal: AbortSignal.timeout(20_000),
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(`更新源返回 HTTP ${response.status}`);
      }
      const body = await response.text();
      if (body.length > MAX_MANIFEST_BYTES) {
        throw new Error("更新 Manifest 过大");
      }
      const parsed = parseUpdateManifest(JSON.parse(body) as unknown, {
        currentVersion: this.options.currentVersion,
        ...(this.options.platform ? { platform: this.options.platform } : {}),
        ...(this.options.arch ? { arch: this.options.arch } : {}),
      });
      this.checkedAt = this.now().toISOString();
      if (compareVersions(parsed.version, this.options.currentVersion) <= 0) {
        this.available = null;
        this.state = "up_to_date";
      } else {
        this.available = parsed;
        this.state = "available";
      }
    } catch (error) {
      this.state = "error";
      this.available = null;
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
    }
    return this.status();
  }

  async download(): Promise<DesktopUpdateStatus> {
    if (this.busy) return this.status();
    if (!this.available) {
      this.state = "error";
      this.error = "当前没有可下载的更新";
      return this.status();
    }
    this.busy = true;
    this.state = "downloading";
    this.error = null;
    this.progress = 0;
    const update = this.available;
    const maxBytes = this.options.maxDownloadBytes ?? MAX_DOWNLOAD_BYTES;
    if (update.sizeBytes !== null && update.sizeBytes > maxBytes) {
      this.busy = false;
      this.state = "error";
      this.error = "更新安装包超过允许的大小";
      return this.status();
    }
    if (
      update.version.length > MAX_VERSION_LENGTH ||
      !UPDATE_VERSION_PATTERN.test(update.version)
    ) {
      this.busy = false;
      this.state = "error";
      this.error = "更新版本号不安全，已拒绝创建安装目录";
      return this.status();
    }
    const installers = path.join(this.options.directory, "installers", update.version);
    await fs.promises.mkdir(installers, { recursive: true, mode: 0o700 });
    const fileName = safeInstallerName(update.url, update.version);
    const target = path.join(installers, fileName);
    const temporary = path.join(installers, `.${randomUUID()}.download`);
    try {
      const response = await this.fetchImpl(update.url, {
        signal: AbortSignal.timeout(30 * 60_000),
      });
      if (!response.ok || !response.body) {
        throw new Error(`下载安装包失败：HTTP ${response.status}`);
      }
      const declared = Number(response.headers.get("content-length") ?? Number.NaN);
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw new Error("更新安装包超过允许的大小");
      }
      const output = fs.createWriteStream(temporary, { mode: 0o600 });
      const hash = createHash("sha256");
      let received = 0;
      try {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          received += value.byteLength;
          if (received > maxBytes) {
            throw new Error("更新安装包超过允许的大小");
          }
          hash.update(value);
          if (!output.write(Buffer.from(value))) {
            await new Promise<void>((resolve, reject) => {
              const onDrain = (): void => {
                cleanup();
                resolve();
              };
              const onError = (error: Error): void => {
                cleanup();
                reject(error);
              };
              const cleanup = (): void => {
                output.off("drain", onDrain);
                output.off("error", onError);
              };
              output.once("drain", onDrain);
              output.once("error", onError);
            });
          }
          const total = update.sizeBytes ?? (Number.isFinite(declared) ? declared : 0);
          this.progress = total > 0 ? Math.min(1, received / total) : null;
        }
        await new Promise<void>((resolve, reject) => {
          output.once("error", reject);
          output.end(resolve);
        });
      } catch (error) {
        output.destroy();
        throw error;
      }
      if (update.sizeBytes !== null && received !== update.sizeBytes) {
        throw new Error(`安装包大小不一致：期望 ${update.sizeBytes}，实际 ${received}`);
      }
      const digest = hash.digest("hex");
      if (digest !== update.sha256) {
        throw new Error("安装包 SHA-256 校验失败，已拒绝该更新");
      }
      await fs.promises.rename(temporary, target);
      this.ready = {
        installerPath: target,
        version: update.version,
        notes: update.notes,
        sha256: digest,
      };
      this.state = "ready";
      this.progress = 1;
    } catch (error) {
      await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
      this.state = "error";
      this.error = error instanceof Error ? error.message : String(error);
      this.ready = null;
      this.progress = null;
    } finally {
      this.busy = false;
    }
    return this.status();
  }

  setState(state: DesktopUpdateState, error: string | null = null): void {
    this.state = state;
    this.error = error;
  }
}

function safeInstallerName(url: string, version: string): string {
  const parsed = new URL(url);
  const base = path.basename(parsed.pathname).replace(/[^A-Za-z0-9._-]/g, "_");
  if (base && base.length <= 120) {
    return base;
  }
  const safeVersion = version.replace(/[^A-Za-z0-9._+-]/g, "_").slice(0, 80);
  return `agent-in-box-${safeVersion}${process.platform === "win32" ? ".exe" : ""}`;
}

/** Files under resources/ that make up the installed app (not user data). */
export const ROLLBACK_RESOURCE_ENTRIES = [
  "app.asar",
  "app.asar.unpacked",
  "control-plane",
  "web",
] as const;

export async function createRollbackSnapshot(input: {
  resourcesPath: string;
  destination: string;
}): Promise<boolean> {
  await fs.promises.mkdir(input.destination, { recursive: true, mode: 0o700 });
  let copied = false;
  for (const entry of ROLLBACK_RESOURCE_ENTRIES) {
    const source = path.join(input.resourcesPath, entry);
    if (!fs.existsSync(source)) continue;
    await fs.promises.cp(source, path.join(input.destination, entry), {
      recursive: true,
      force: true,
    });
    copied = true;
  }
  return copied;
}

export async function restoreRollbackSnapshot(input: {
  source: string;
  resourcesPath: string;
}): Promise<void> {
  if (!fs.existsSync(input.source)) {
    throw new Error("回滚快照不存在，无法恢复旧版本");
  }
  for (const entry of ROLLBACK_RESOURCE_ENTRIES) {
    const backup = path.join(input.source, entry);
    if (!fs.existsSync(backup)) continue;
    const target = path.join(input.resourcesPath, entry);
    await fs.promises.rm(target, { recursive: true, force: true });
    await fs.promises.cp(backup, target, { recursive: true, force: true });
  }
}

export async function backupDatabase(input: {
  databasePath: string;
  destination: string;
}): Promise<string> {
  await fs.promises.mkdir(input.destination, { recursive: true, mode: 0o700 });
  let copied = false;
  for (const suffix of ["", "-wal", "-shm"]) {
    const source = `${input.databasePath}${suffix}`;
    if (!fs.existsSync(source)) continue;
    await fs.promises.copyFile(
      source,
      path.join(input.destination, `agent-in-box.sqlite${suffix}`),
    );
    copied = true;
  }
  if (!copied) {
    throw new Error(`数据库文件不存在：${input.databasePath}`);
  }
  return input.destination;
}

export async function restoreDatabase(input: {
  backupPath: string;
  databasePath: string;
}): Promise<void> {
  const backupFile = path.join(input.backupPath, "agent-in-box.sqlite");
  if (!fs.existsSync(backupFile)) {
    throw new Error(`数据库备份不存在：${backupFile}`);
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    await fs.promises.rm(`${input.databasePath}${suffix}`, { force: true });
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    const source = path.join(input.backupPath, `agent-in-box.sqlite${suffix}`);
    if (!fs.existsSync(source)) continue;
    await fs.promises.copyFile(source, `${input.databasePath}${suffix}`);
  }
}
