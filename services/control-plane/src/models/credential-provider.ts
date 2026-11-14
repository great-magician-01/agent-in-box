import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import type { CredentialKind } from "@agent-in-box/protocol";
import { PersistenceError } from "../persistence/errors";

export interface ModelCredentialProvider {
  getSecret(providerId: string): Promise<string>;
}

interface BridgeDescriptor {
  url: string;
  token: string;
}

export interface HostCredentialProviderOptions {
  descriptorPath?: string;
  developmentCredentialsFile?: string;
  fetchImpl?: typeof fetch;
  /** Model and bot credentials live in separate namespaces. */
  kind?: CredentialKind;
  /** Used in operator-facing errors, e.g. 模型 or 机器人. */
  purpose?: string;
}

/**
 * Decrypts only in the Electron main process through a loopback bridge. The
 * optional file provider is explicitly for development/Smoke and requires 0600.
 */
export class HostCredentialProvider implements ModelCredentialProvider {
  private readonly descriptorPath?: string;
  private readonly developmentCredentialsFile?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly purpose: string;
  private readonly kind: CredentialKind;

  constructor(options: HostCredentialProviderOptions = {}) {
    const descriptor =
      options.descriptorPath ?? process.env.AGENT_IN_BOX_CREDENTIAL_BRIDGE_DESCRIPTOR?.trim();
    const credentials =
      options.developmentCredentialsFile ?? process.env.AGENT_IN_BOX_MODEL_CREDENTIALS_FILE?.trim();
    if (descriptor) this.descriptorPath = path.resolve(descriptor);
    if (credentials) this.developmentCredentialsFile = path.resolve(credentials);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.purpose = options.purpose ?? "模型";
    this.kind = options.kind ?? "model";
  }

  async getSecret(providerId: string): Promise<string> {
    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(providerId)) {
      throw new PersistenceError("validation_failed", "凭据 Provider 标识无效");
    }
    if (this.descriptorPath) {
      try {
        return await this.fromBridge(providerId);
      } catch (error) {
        if (this.developmentCredentialsFile && isMissing(error)) {
          return this.fromDevelopmentFile(providerId);
        }
        throw error;
      }
    }
    if (this.developmentCredentialsFile) return this.fromDevelopmentFile(providerId);
    throw new PersistenceError(
      "unavailable",
      `${this.purpose}凭据桥未配置。请从 Electron 启动，或仅在开发环境设置开发凭据文件。`,
    );
  }

  private async fromBridge(providerId: string): Promise<string> {
    const descriptor = await readJsonFile<BridgeDescriptor>(this.descriptorPath!, true);
    const url = new URL(descriptor.url);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "::1"].includes(hostname) ||
      url.username ||
      url.password ||
      typeof descriptor.token !== "string" ||
      !descriptor.token
    ) {
      throw new PersistenceError("unavailable", "Electron 凭据桥描述文件无效");
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${descriptor.url.replace(/\/$/, "")}/v1/decrypt`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${descriptor.token}`,
        },
        body: JSON.stringify({ kind: this.kind, providerId }),
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      throw new PersistenceError(
        "unavailable",
        `Electron 凭据桥不可用：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok) {
      await response.arrayBuffer();
      throw new PersistenceError(
        response.status === 404 ? "validation_failed" : "unavailable",
        response.status === 404
          ? `系统安全存储中没有 Provider ${providerId} 的凭据`
          : `Electron 凭据桥返回 HTTP ${response.status}`,
      );
    }
    const payload = (await response.json()) as { secret?: unknown };
    if (typeof payload.secret !== "string" || payload.secret.length < 8) {
      throw new PersistenceError("unavailable", "Electron 凭据桥返回了无效凭据");
    }
    return payload.secret;
  }

  private async fromDevelopmentFile(providerId: string): Promise<string> {
    const values = await readJsonFile<Record<string, unknown>>(
      this.developmentCredentialsFile!,
      true,
    );
    const secret =
      values[`${this.kind}:${providerId}`] ??
      // Backward-compatible development files used a flat map. Only accept a
      // flat key when its implicit namespace matches the provider kind.
      (legacyKindForId(providerId) === this.kind ? values[providerId] : undefined);
    if (typeof secret !== "string" || secret.length < 8 || secret.length > 16_384) {
      throw new PersistenceError(
        "validation_failed",
        `开发凭据文件中没有 Provider ${providerId} 的有效凭据`,
      );
    }
    return secret;
  }
}

async function readJsonFile<T>(file: string, requirePrivateMode: boolean): Promise<T> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) {
      throw new Error("not a small regular file");
    }
    if (requirePrivateMode && process.platform !== "win32" && (info.mode & 0o077) !== 0) {
      throw new PersistenceError("validation_failed", `开发凭据文件 ${file} 必须使用 0600 权限`);
    }
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if (error instanceof PersistenceError) throw error;
    throw new PersistenceError(
      isMissing(error) ? "unavailable" : "validation_failed",
      `无法读取凭据配置 ${file}：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function legacyKindForId(providerId: string): CredentialKind {
  return providerId.startsWith("bot-") ? "bot" : "model";
}

function isMissing(error: unknown): boolean {  return (
    (typeof error === "object" &&
      error !== null &&
      (error as NodeJS.ErrnoException).code === "ENOENT") ||
    (error instanceof PersistenceError && error.message.includes("ENOENT"))
  );
}
