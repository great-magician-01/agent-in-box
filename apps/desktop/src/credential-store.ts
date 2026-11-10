import fs from "node:fs";
import path from "node:path";
import type { CredentialSaveRequest, DesktopCredentialStatus } from "@agent-in-box/protocol";
import type { LoggerLike } from "./logger";

export interface SafeStoragePort {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export interface CredentialStoreOptions {
  filePath: string;
  safeStorage: SafeStoragePort;
  platform?: NodeJS.Platform;
  now?: () => Date;
  logger?: LoggerLike;
}

interface StoredCredential {
  ciphertext: string;
  updatedAt: string;
}

interface CredentialFile {
  version: 1;
  credentials: Record<string, StoredCredential>;
}

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const MIN_SECRET_LENGTH = 8;
const MAX_SECRET_LENGTH = 16_384;

export class CredentialStore {
  private readonly filePath: string;
  private readonly safeStorage: SafeStoragePort;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => Date;
  private readonly logger: LoggerLike | undefined;

  constructor(options: CredentialStoreOptions) {
    this.filePath = options.filePath;
    this.safeStorage = options.safeStorage;
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger;
  }

  private availability(): {
    available: boolean;
    backend: string | null;
    message: string | null;
  } {
    let backend: string | null = null;
    try {
      backend = this.safeStorage.getSelectedStorageBackend?.() ?? null;
    } catch {
      backend = null;
    }

    try {
      if (!this.safeStorage.isEncryptionAvailable()) {
        return {
          available: false,
          backend,
          message:
            "当前系统没有可用的加密存储（Windows DPAPI / macOS Keychain / Linux Secret Service）。模型凭据不会被保存。",
        };
      }
    } catch (error) {
      return {
        available: false,
        backend,
        message: `无法访问系统安全存储：${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (this.platform === "linux" && backend === "basic_text") {
      return {
        available: false,
        backend,
        message:
          "Linux 未检测到可用的密钥环（libsecret/kwallet），safeStorage 只能提供不安全的 basic_text。为避免明文落盘，凭据保存已禁用。",
      };
    }

    return { available: true, backend, message: null };
  }

  private readFile(): CredentialFile {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { version: 1, credentials: {} };
      }
      const record = parsed as Record<string, unknown>;
      const credentials: Record<string, StoredCredential> = {};
      if (typeof record.credentials === "object" && record.credentials !== null) {
        for (const [providerId, value] of Object.entries(
          record.credentials as Record<string, unknown>,
        )) {
          if (
            PROVIDER_ID_PATTERN.test(providerId) &&
            typeof value === "object" &&
            value !== null &&
            typeof (value as Record<string, unknown>).ciphertext === "string" &&
            typeof (value as Record<string, unknown>).updatedAt === "string"
          ) {
            credentials[providerId] = {
              ciphertext: (value as Record<string, unknown>).ciphertext as string,
              updatedAt: (value as Record<string, unknown>).updatedAt as string,
            };
          }
        }
      }
      return { version: 1, credentials };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, credentials: {} };
      }
      throw new Error(
        `无法读取凭据存储：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private writeFile(file: CredentialFile): void {
    const directory = path.dirname(path.resolve(this.filePath));
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `.credentials.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    try {
      fs.renameSync(temporary, this.filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "EPERM") {
        fs.rmSync(this.filePath, { force: true });
        fs.renameSync(temporary, this.filePath);
      } else {
        fs.rmSync(temporary, { force: true });
        throw error;
      }
    }
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      // Windows does not use POSIX modes.
    }
  }

  status(): DesktopCredentialStatus {
    const availability = this.availability();
    if (!availability.available) {
      return {
        secureStorageAvailable: false,
        storageBackend: availability.backend,
        message: availability.message,
        providers: [],
      };
    }
    const file = this.readFile();
    return {
      secureStorageAvailable: true,
      storageBackend: availability.backend,
      message: null,
      providers: Object.entries(file.credentials)
        .map(([providerId, value]) => ({ providerId, updatedAt: value.updatedAt }))
        .sort((left, right) => left.providerId.localeCompare(right.providerId)),
    };
  }

  save(request: CredentialSaveRequest): DesktopCredentialStatus {
    if (
      typeof request !== "object" ||
      request === null ||
      typeof request.providerId !== "string" ||
      !PROVIDER_ID_PATTERN.test(request.providerId)
    ) {
      throw new Error("模型 Provider 标识格式无效");
    }
    if (typeof request.secret !== "string") {
      throw new Error("模型凭据格式无效");
    }
    const secret = request.secret.trim();
    if (secret.length < MIN_SECRET_LENGTH || secret.length > MAX_SECRET_LENGTH) {
      throw new Error(`模型凭据长度必须在 ${MIN_SECRET_LENGTH} 到 ${MAX_SECRET_LENGTH} 之间`);
    }

    const availability = this.availability();
    if (!availability.available) {
      throw new Error(availability.message ?? "系统安全存储不可用");
    }

    const encrypted = this.safeStorage.encryptString(secret);
    const file = this.readFile();
    file.credentials[request.providerId] = {
      ciphertext: encrypted.toString("base64"),
      updatedAt: this.now().toISOString(),
    };
    this.writeFile(file);
    this.logger?.info("模型凭据已写入系统安全存储", {
      providerId: request.providerId,
    });
    return this.status();
  }

  remove(providerId: string): DesktopCredentialStatus {
    if (typeof providerId !== "string" || !PROVIDER_ID_PATTERN.test(providerId)) {
      throw new Error("模型 Provider 标识格式无效");
    }
    const file = this.readFile();
    if (file.credentials[providerId]) {
      delete file.credentials[providerId];
      this.writeFile(file);
      this.logger?.info("模型凭据已删除", { providerId });
    }
    return this.status();
  }

  /** Only used by the (future) Model Broker in the main process. */
  decrypt(providerId: string): string | null {
    const availability = this.availability();
    if (!availability.available) {
      return null;
    }
    const stored = this.readFile().credentials[providerId];
    if (!stored) {
      return null;
    }
    return this.safeStorage.decryptString(Buffer.from(stored.ciphertext, "base64"));
  }
}
