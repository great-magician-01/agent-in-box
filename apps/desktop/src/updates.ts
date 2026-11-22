import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  DesktopUpdateRollbackView,
  DesktopUpdateState,
  DesktopUpdateStatus,
} from "@agent-in-box/protocol";
import { canonicalJson, verifySignature } from "./signature";

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

export interface SignedUpdateEnvelope {
  manifest: UpdateManifest;
  /** Base64 Ed25519 signature over canonical JSON of `manifest`. */
  signature: string;
}

export { canonicalJson };

/**
 * Verifies the Ed25519 signature before any manifest field is trusted. The
 * signature covers the canonical form of `manifest` under the
 * `desktop-update` purpose domain, so a runtime-asset signature can never be
 * replayed as an update.
 */
export function verifyUpdateEnvelope(raw: unknown, publicKey: string): UpdateManifest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("更新响应必须是 JSON 对象");
  }
  const envelope = raw as Record<string, unknown>;
  if (
    typeof envelope.signature !== "string" ||
    envelope.signature.length < 16 ||
    envelope.signature.length > 4096
  ) {
    throw new Error("更新 Manifest 缺少有效签名");
  }
  if (typeof envelope.manifest !== "object" || envelope.manifest === null) {
    throw new Error("更新 Manifest 缺少 manifest 字段");
  }
  let valid = false;
  try {
    valid = verifySignature("desktop-update", envelope.manifest, publicKey, envelope.signature);
  } catch {
    throw new Error("更新签名公钥无效");
  }
  if (!valid) {
    throw new Error("更新 Manifest 签名校验失败，已拒绝该更新");
  }
  return envelope.manifest as UpdateManifest;
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
  /** Ed25519 public key (PEM or base64 SPKI). Updates are disabled without it. */
  publicKey?: string;
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
  interface Parsed {
    core: number[];
    prerelease: string[];
  }
  const parse = (value: string): Parsed => {
    const trimmed = value.trim().replace(/^v/i, "");
    const withoutBuild = trimmed.split("+")[0]!;
    const [coreText, prereleaseText] = withoutBuild.split("-", 2) as [string, string | undefined];
    const parts = coreText.split(".").map((part) => Number(part));
    if (
      coreText === "" ||
      parts.length === 0 ||
      parts.some((part) => !Number.isInteger(part) || part < 0) ||
      parts.length > 3
    ) {
      throw new Error(`无效版本号：${value}`);
    }
    while (parts.length < 3) parts.push(0);
    const prerelease =
      prereleaseText === undefined
        ? []
        : prereleaseText.split(".").filter((identifier) => identifier !== "");
    return { core: parts.slice(0, 3), prerelease };
  };
  const comparePrerelease = (a: string[], b: string[]): number => {
    // A version without a prerelease is newer than any prerelease of the same
    // core (1.0.0 > 1.0.0-rc.1), which is what lets stable builds replace RCs.
    if (a.length === 0 && b.length === 0) return 0;
    if (a.length === 0) return 1;
    if (b.length === 0) return -1;
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
      const leftIdentifier = a[index];
      const rightIdentifier = b[index];
      if (leftIdentifier === undefined) return -1;
      if (rightIdentifier === undefined) return 1;
      const leftNumeric = /^\d+$/.test(leftIdentifier);
      const rightNumeric = /^\d+$/.test(rightIdentifier);
      if (leftNumeric && rightNumeric) {
        const leftValue = Number(leftIdentifier);
        const rightValue = Number(rightIdentifier);
        if (leftValue !== rightValue) return leftValue > rightValue ? 1 : -1;
        continue;
      }
      if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
      if (leftIdentifier !== rightIdentifier) return leftIdentifier > rightIdentifier ? 1 : -1;
    }
    return 0;
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index]! !== b.core[index]!) return a.core[index]! > b.core[index]! ? 1 : -1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
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
      if (!this.options.publicKey) {
        throw new Error("更新签名公钥未配置，已禁用自动更新");
      }
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
        redirect: "error",
      });
      if (!response.ok) {
        throw new Error(`更新源返回 HTTP ${response.status}`);
      }
      const body = await response.text();
      if (body.length > MAX_MANIFEST_BYTES) {
        throw new Error("更新 Manifest 过大");
      }
      const manifest = verifyUpdateEnvelope(JSON.parse(body) as unknown, this.options.publicKey);
      const parsed = parseUpdateManifest(manifest, {
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
        redirect: "error",
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
  "vm-supervisor",
  "guest-runtime",
  "router-runtime",
  "update-public-key.pem",
  "runtime-public-key.pem",
] as const;

const ROLLBACK_MANIFEST = "rollback-manifest.json";

interface RollbackEntryDigest {
  files: number;
  bytes: number;
  sha256: string;
}

interface RollbackManifest {
  version: 1;
  createdAt: string;
  entries: Record<string, RollbackEntryDigest>;
}

async function hashTree(root: string): Promise<RollbackEntryDigest> {
  const hasher = createHash("sha256");
  let files = 0;
  let bytes = 0;
  const walk = async (directory: string, relative: string): Promise<void> => {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        throw new Error(`回滚资源包含符号链接，已拒绝：${name}`);
      }
      if (entry.isDirectory()) {
        await walk(absolute, name);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`回滚资源包含非普通文件，已拒绝：${name}`);
      }
      const data = await fs.promises.readFile(absolute);
      // Length-prefixed path and size keep the digest unambiguous.
      hasher.update(`${Buffer.byteLength(name)}:`);
      hasher.update(name);
      hasher.update(`:${data.length}:`);
      hasher.update(data);
      files += 1;
      bytes += data.length;
    }
  };
  const stats = await fs.promises.stat(root);
  if (stats.isDirectory()) {
    await walk(root, "");
  } else if (stats.isFile()) {
    const data = await fs.promises.readFile(root);
    hasher.update(`${path.basename(root)}:${data.length}:`);
    hasher.update(data);
    files = 1;
    bytes = data.length;
  }
  return { files, bytes, sha256: hasher.digest("hex") };
}

async function readRollbackManifest(source: string): Promise<RollbackManifest> {
  const raw = await fs.promises.readFile(path.join(source, ROLLBACK_MANIFEST), "utf8");
  const parsed = JSON.parse(raw) as Partial<RollbackManifest>;
  if (parsed.version !== 1 || typeof parsed.entries !== "object" || parsed.entries === null) {
    throw new Error("回滚快照清单无效");
  }
  return parsed as RollbackManifest;
}

export async function createRollbackSnapshot(input: {
  resourcesPath: string;
  destination: string;
}): Promise<boolean> {
  const existing = await fs.promises
    .stat(input.destination)
    .then(() => true)
    .catch(() => false);
  if (existing) {
    try {
      await verifyRollbackSnapshot(input.destination);
      return true;
    } catch {
      // An incomplete snapshot is replaced below; a verified one is reused.
      await fs.promises.rm(input.destination, { recursive: true, force: true });
    }
  }

  const staging = `${input.destination}.staging-${randomUUID()}`;
  await fs.promises.mkdir(staging, { recursive: true, mode: 0o700 });
  const entries: Record<string, RollbackEntryDigest> = {};
  try {
    for (const entry of ROLLBACK_RESOURCE_ENTRIES) {
      const source = path.join(input.resourcesPath, entry);
      const present = await fs.promises
        .stat(source)
        .then(() => true)
        .catch(() => false);
      if (!present) continue;
      const target = path.join(staging, entry);
      await fs.promises.cp(source, target, { recursive: true, force: true, dereference: false });
      entries[entry] = await hashTree(target);
    }
    if (Object.keys(entries).length === 0) {
      throw new Error(`没有可回滚的已安装资源：${input.resourcesPath}`);
    }
    const manifest: RollbackManifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      entries,
    };
    await fs.promises.writeFile(
      path.join(staging, ROLLBACK_MANIFEST),
      JSON.stringify(manifest, null, 2),
      { mode: 0o600 },
    );
    await fs.promises.mkdir(path.dirname(input.destination), { recursive: true, mode: 0o700 });
    await fs.promises.rename(staging, input.destination);
    return true;
  } catch (error) {
    await fs.promises.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function verifyRollbackSnapshot(source: string): Promise<RollbackManifest> {
  if (!fs.existsSync(source)) {
    throw new Error("回滚快照不存在，无法恢复旧版本");
  }
  const manifest = await readRollbackManifest(source);
  for (const [entry, expected] of Object.entries(manifest.entries)) {
    const digest = await hashTree(path.join(source, entry));
    if (digest.sha256 !== expected.sha256 || digest.files !== expected.files) {
      throw new Error(`回滚快照中的 ${entry} 校验失败`);
    }
  }
  return manifest;
}

export async function restoreRollbackSnapshot(input: {
  source: string;
  resourcesPath: string;
}): Promise<void> {
  // Verify every file before replacing anything, so a corrupt backup cannot
  // leave a mix of old and new runtime components.
  const manifest = await verifyRollbackSnapshot(input.source);
  const staging = path.join(input.resourcesPath, `.rollback-staging-${randomUUID()}`);
  await fs.promises.mkdir(staging, { recursive: true, mode: 0o700 });
  const staged = new Set<string>();
  try {
    for (const entry of Object.keys(manifest.entries)) {
      const from = path.join(input.source, entry);
      const to = path.join(staging, entry);
      await fs.promises.cp(from, to, { recursive: true, force: true, dereference: false });
      const digest = await hashTree(to);
      if (digest.sha256 !== manifest.entries[entry]!.sha256) {
        throw new Error(`暂存回滚资源 ${entry} 校验失败`);
      }
      staged.add(entry);
    }
    const restorePoint = new Date().toISOString().replace(/[:.]/g, "-");
    const replaced: Array<{ target: string; previous: string }> = [];
    try {
      for (const entry of staged) {
        const target = path.join(input.resourcesPath, entry);
        const previous = `${target}.pre-rollback-${restorePoint}`;
        const targetExists = await fs.promises
          .stat(target)
          .then(() => true)
          .catch(() => false);
        if (targetExists) {
          await fs.promises.rename(target, previous);
        }
        try {
          await fs.promises.rename(path.join(staging, entry), target);
        } catch (error) {
          if (targetExists) {
            await fs.promises.rename(previous, target).catch(() => undefined);
          }
          throw error;
        }
        replaced.push({ target, previous });
      }
    } catch (error) {
      // Best-effort roll back of the resources already swapped in this pass.
      for (const item of replaced.reverse()) {
        await fs.promises.rm(item.target, { recursive: true, force: true });
        await fs.promises.rename(item.previous, item.target).catch(() => undefined);
      }
      throw error;
    }
    for (const item of replaced) {
      await fs.promises.rm(item.previous, { recursive: true, force: true }).catch(() => undefined);
    }
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => undefined);
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
