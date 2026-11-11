import fs from "node:fs";
import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { LoggerLike } from "./logger";

export interface CredentialDecryptor {
  decrypt(providerId: string): string | null;
}

export interface CredentialBridgeOptions {
  descriptorPath: string;
  credentialStore: CredentialDecryptor;
  logger?: LoggerLike;
  /** Test hook. */
  serverFactory?: () => Server;
}

/**
 * Loopback bridge between the sandboxed host control plane and Electron's
 * safeStorage. The descriptor file is 0600 and contains a per-process bearer
 * token; the long-lived provider key never leaves this process in plaintext.
 */
export class CredentialBridge {
  private readonly descriptorPath: string;
  private readonly credentialStore: CredentialDecryptor;
  private readonly logger: LoggerLike | undefined;
  private readonly token = randomBytes(32).toString("base64url");
  private readonly server: Server;
  private started = false;

  constructor(options: CredentialBridgeOptions) {
    this.descriptorPath = path.resolve(options.descriptorPath);
    this.credentialStore = options.credentialStore;
    this.logger = options.logger;
    this.server = (options.serverFactory ?? http.createServer)();
    this.server.on("request", (request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        this.logger?.warn("凭据桥请求失败", { error: String(error) });
        if (!response.headersSent) this.write(response, 500, { error: "internal_error" });
      });
    });
  }

  async start(): Promise<void> {
    if (this.started) throw new Error("Credential bridge is already started");
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    this.started = true;
    const address = this.server.address() as AddressInfo;
    const descriptor = {
      version: 1,
      url: `http://127.0.0.1:${address.port}`,
      token: this.token,
      createdAt: new Date().toISOString(),
    };
    const directory = path.dirname(this.descriptorPath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `.credential-bridge.${process.pid}.tmp`);
    fs.writeFileSync(temporary, `${JSON.stringify(descriptor)}\n`, { mode: 0o600 });
    try {
      fs.renameSync(temporary, this.descriptorPath);
    } catch {
      fs.rmSync(this.descriptorPath, { force: true });
      fs.renameSync(temporary, this.descriptorPath);
    }
    try {
      fs.chmodSync(this.descriptorPath, 0o600);
    } catch {
      // Windows does not use POSIX modes.
    }
    this.logger?.info("模型凭据桥已启动", { port: address.port });
  }

  stop(): void {
    if (!this.started) return;
    this.server.close();
    this.started = false;
    try {
      fs.rmSync(this.descriptorPath, { force: true });
    } catch {
      // Best effort cleanup; the descriptor only contains a short-lived token.
    }
    this.logger?.info("模型凭据桥已停止");
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (request.method !== "POST" || request.url !== "/v1/decrypt") {
      this.write(response, 404, { error: "not_found" });
      return;
    }
    const provided = request.headers.authorization ?? "";
    const expected = `Bearer ${this.token}`;
    if (
      provided.length !== expected.length ||
      !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
    ) {
      this.write(response, 401, { error: "unauthorized" });
      return;
    }
    const body = await readBody(request, 4096);
    let providerId: unknown;
    try {
      providerId = (JSON.parse(body.toString("utf8")) as { providerId?: unknown }).providerId;
    } catch {
      this.write(response, 400, { error: "bad_request" });
      return;
    }
    if (typeof providerId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(providerId)) {
      this.write(response, 400, { error: "bad_request" });
      return;
    }
    const secret = this.credentialStore.decrypt(providerId);
    if (!secret) {
      this.write(response, 404, { error: "credential_missing" });
      return;
    }
    this.write(response, 200, { secret });
  }

  private write(response: ServerResponse, status: number, body: unknown): void {
    if (response.headersSent) return;
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(body));
  }
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > limit) throw new Error("credential bridge request exceeds size limit");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
