import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { lstat, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import type { Kysely } from "kysely";
import { DatabaseService } from "../persistence/database.service";
import { PersistenceError } from "../persistence/errors";
import type { DatabaseSchema } from "../persistence/schema";
import { nowIso } from "../persistence/time";
import { KYSELY } from "../persistence/tokens";

const DEFAULT_PORT = 6722;
const PROFILE = "linux-desktop-worker";
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

interface RuntimeAsset {
  name: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
}

interface GuestRuntimeManifest {
  schemaVersion: number;
  guestRuntimeVersion: string;
  profile: string;
  nodeVersion: string;
  piVersion: string;
  assets: RuntimeAsset[];
}

export interface ProvisioningContext {
  url: string;
  profile: string;
}

@Injectable()
export class ProvisioningService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProvisioningService.name);
  private readonly runtimeDirectory: string;
  private readonly port: number;
  private server: ReturnType<typeof createServer> | null = null;
  private secret: Buffer | null = null;
  private manifest: GuestRuntimeManifest | null = null;
  private readonly assets = new Map<string, RuntimeAsset>();
  private unavailableReason: string | null = null;
  private boundPort = 0;

  constructor(
    private readonly database: DatabaseService,
    @Inject(KYSELY) private readonly db: Kysely<DatabaseSchema>,
  ) {
    const runtimeCandidates = [
      process.env.AGENT_IN_BOX_GUEST_RUNTIME_DIR?.trim(),
      path.resolve(process.cwd(), "release", "guest-runtime", "linux-amd64"),
      path.resolve(__dirname, "..", "..", "..", "..", "release", "guest-runtime", "linux-amd64"),
    ].filter((value): value is string => Boolean(value));
    this.runtimeDirectory =
      runtimeCandidates.find((candidate) => existsSync(path.join(candidate, "manifest.json"))) ??
      runtimeCandidates[0] ??
      path.resolve("release/guest-runtime/linux-amd64");
    const parsed = Number(process.env.AGENT_IN_BOX_PROVISIONING_PORT ?? DEFAULT_PORT);
    this.port = Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535 ? parsed : DEFAULT_PORT;
  }

  async onModuleInit(): Promise<void> {
    try {
      this.secret = await this.loadSecret();
      await this.loadManifest();
      await this.startServer();
    } catch (error) {
      this.unavailableReason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Cloud-init provisioning unavailable: ${this.unavailableReason}`);
    }
  }

  onModuleDestroy(): void {
    this.server?.close();
    this.server = null;
  }

  availableFor(profile: string): boolean {
    return (
      profile === PROFILE &&
      this.manifest?.profile === PROFILE &&
      this.unavailableReason === null &&
      this.server !== null
    );
  }

  unavailableMessage(): string {
    return (
      this.unavailableReason ??
      `Guest Runtime 资产目录不可用：${this.runtimeDirectory}；请先执行 pnpm package:guest-runtime`
    );
  }

  contextFor(vmId: string): ProvisioningContext {
    if (!this.secret || this.unavailableReason) {
      throw new PersistenceError("unavailable", this.unavailableMessage());
    }
    const token = createHmac("sha256", this.secret).update(vmId).digest("base64url");
    return {
      url: `http://10.0.2.2:${this.boundPort || this.port}/v1/${encodeURIComponent(vmId)}/${token}/`,
      profile: PROFILE,
    };
  }

  async markInstalling(vmId: string): Promise<void> {
    await this.db
      .updateTable("vm_instances")
      .set({
        provisioning_state: "installing",
        provisioning_message: "Guest 正在安装桌面、Guest Agent 与 Worker",
      })
      .where("id", "=", vmId)
      .where("provisioning_state", "in", ["none", "waiting", "installing"])
      .execute();
  }

  async markReady(vmId: string): Promise<void> {
    await this.db
      .updateTable("vm_instances")
      .set({
        provisioning_state: "ready",
        provisioning_message: "桌面、Guest Agent 与 Worker 已就绪",
        guest_health: "healthy",
      })
      .where("id", "=", vmId)
      .execute();
  }

  async markFailed(vmId: string, message: string): Promise<void> {
    await this.db
      .updateTable("vm_instances")
      .set({
        provisioning_state: "failed",
        provisioning_message: message.slice(0, 2000),
      })
      .where("id", "=", vmId)
      .execute();
  }

  async markStarting(vmId: string): Promise<void> {
    await this.db
      .updateTable("vm_instances")
      .set({
        provisioning_state: "waiting",
        provisioning_message: "等待 Guest 首次启动并连接 provisioning 服务",
        provisioning_started_at: nowIso(),
      })
      .where("id", "=", vmId)
      .execute();
  }

  private async loadSecret(): Promise<Buffer> {
    const file = path.join(this.database.dataRoot, "provisioning.key");
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size < 32 || info.size > 4096) {
        throw new Error("provisioning.key 必须是 32～4096 字节的普通文件且不能是符号链接");
      }
      return await readFile(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const secret = randomBytes(32);
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file, secret, { mode: 0o600, flag: "wx" });
      return secret;
    }
  }

  private async loadManifest(): Promise<void> {
    const manifestPath = path.join(this.runtimeDirectory, "manifest.json");
    const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Guest Runtime Manifest 格式无效");
    }
    const manifest = parsed as GuestRuntimeManifest;
    if (
      manifest.schemaVersion !== 1 ||
      manifest.profile !== PROFILE ||
      !Array.isArray(manifest.assets)
    ) {
      throw new Error("Guest Runtime Manifest 不受支持");
    }
    const assets = new Map<string, RuntimeAsset>();
    for (const asset of manifest.assets) {
      if (
        typeof asset?.name !== "string" ||
        !/^[A-Za-z0-9._-]{1,128}$/.test(asset.name) ||
        typeof asset.fileName !== "string" ||
        typeof asset.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/i.test(asset.sha256) ||
        !Number.isSafeInteger(asset.sizeBytes) ||
        asset.sizeBytes < 1 ||
        assets.has(asset.name)
      ) {
        throw new Error("Guest Runtime Manifest 资产字段无效");
      }
      const file = path.join(this.runtimeDirectory, asset.name);
      const info = await stat(file);
      if (!info.isFile() || info.size !== asset.sizeBytes) {
        throw new Error(`Guest Runtime 资产缺失或大小不符：${asset.name}`);
      }
      const hash = createHash("sha256")
        .update(await readFile(file))
        .digest("hex");
      if (hash !== asset.sha256.toLowerCase()) {
        throw new Error(`Guest Runtime 资产 SHA-256 不符：${asset.name}`);
      }
      assets.set(asset.name, asset);
    }
    this.manifest = manifest;
    this.assets.clear();
    for (const [name, asset] of assets) this.assets.set(name, asset);
  }

  private async startServer(): Promise<void> {
    const server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        this.logger.warn(`Provisioning request failed: ${String(error)}`);
        if (!response.headersSent) {
          response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        }
        response.end("provisioning failed\n");
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
    const address = server.address();
    this.boundPort = typeof address === "object" && address ? address.port : this.port;
    this.logger.log(`Cloud-init provisioning listening on 127.0.0.1:${this.boundPort}`);
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!LOOPBACK.has(request.socket.remoteAddress ?? "")) {
      this.send(response, 403, "text/plain", "loopback only");
      return;
    }
    if (request.method !== "GET" && request.method !== "POST") {
      this.send(response, 405, "text/plain", "method not allowed");
      return;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments[0] !== "v1" || segments.length < 4) {
      this.send(response, 404, "text/plain", "not found");
      return;
    }
    const vmId = decodeURIComponent(segments[1] ?? "");
    const token = segments[2] ?? "";
    const resource = segments[3] ?? "";
    if (!this.secret || !this.validToken(vmId, token)) {
      this.send(response, 403, "text/plain", "invalid provisioning token");
      return;
    }
    const vm = await this.db
      .selectFrom("vm_instances")
      .select(["id", "storage_root", "provisioning_state"])
      .where("id", "=", vmId)
      .executeTakeFirst();
    if (!vm) {
      this.send(response, 404, "text/plain", "vm not found");
      return;
    }
    if (resource === "ready" || resource === "fail") {
      if (request.method !== "POST") {
        this.send(response, 405, "text/plain", "method not allowed");
        return;
      }
      if (resource === "ready") {
        await this.markReady(vmId);
      } else {
        const message = url.searchParams.get("message")?.trim() || "Guest provisioning failed";
        await this.markFailed(vmId, message);
      }
      this.send(response, 200, "text/plain", "ok");
      return;
    }
    if (vm.provisioning_state === "ready") {
      this.send(response, 410, "text/plain", "provisioning already complete");
      return;
    }
    if (request.method !== "GET") {
      this.send(response, 405, "text/plain", "method not allowed");
      return;
    }
    if (resource === "meta-data") {
      this.send(
        response,
        200,
        "text/yaml",
        [
          `instance-id: ${vmId}`,
          `local-hostname: aib-${vmId.slice(0, 8)}`,
          "manage_etc_hosts: true",
          "",
        ].join("\n"),
      );
      return;
    }
    if (resource === "user-data") {
      await this.markInstalling(vmId);
      this.send(response, 200, "text/yaml", this.buildUserData(vmId));
      return;
    }
    if (resource === "assets" && segments.length >= 5) {
      const asset = this.assets.get(decodeURIComponent(segments[4] ?? ""));
      if (!asset) {
        this.send(response, 404, "text/plain", "asset not found");
        return;
      }
      this.sendFile(response, path.join(this.runtimeDirectory, asset.name), asset.sizeBytes);
      return;
    }
    if (resource === "tokens" && segments.length >= 5) {
      const name = decodeURIComponent(segments[4] ?? "");
      if (name !== "guest-agent.token" && name !== "worker-rpc.token") {
        this.send(response, 404, "text/plain", "token not found");
        return;
      }
      const file = path.join(vm.storage_root, name);
      const info = await stat(file).catch(() => null);
      if (!info?.isFile()) {
        this.send(response, 404, "text/plain", "token not provisioned");
        return;
      }
      this.sendFile(response, file, info.size);
      return;
    }
    this.send(response, 404, "text/plain", "not found");
  }

  private validToken(vmId: string, supplied: string): boolean {
    const expected = createHmac("sha256", this.secret ?? Buffer.alloc(0))
      .update(vmId)
      .digest("base64url");
    const left = Buffer.from(expected);
    const right = Buffer.from(supplied);
    return left.length === right.length && timingSafeEqual(left, right);
  }

  private buildUserData(vmId: string): string {
    const context = this.contextFor(vmId);
    const base = context.url;
    const script = this.buildProvisionScript(base);
    const hostname = `aib-${vmId.slice(0, 8)}`;
    return [
      "#cloud-config",
      `hostname: ${hostname}`,
      "manage_etc_hosts: true",
      "ssh_pwauth: false",
      "package_update: true",
      "packages:",
      "  - xfce4",
      "  - lightdm",
      "  - x11-xserver-utils",
      "  - dbus-x11",
      "  - curl",
      "  - ca-certificates",
      "users:",
      "  - default",
      "  - name: aib",
      "    groups: [sudo, audio, video]",
      "    shell: /bin/bash",
      "    lock_passwd: true",
      "    sudo: ALL=(ALL) NOPASSWD:ALL",
      "write_files:",
      "  - path: /usr/local/sbin/aib-provision.sh",
      "    permissions: '0700'",
      "    owner: root:root",
      "    content: |",
      ...script.split("\n").map((line) => `      ${line}`),
      "runcmd:",
      "  - [bash, -lc, 'timeout 2400 /usr/local/sbin/aib-provision.sh']",
      "final_message: 'Agent-in-Box guest provisioning finished'",
      "",
    ].join("\n");
  }

  private buildProvisionScript(base: string): string {
    const asset = (name: string): string => {
      const item = this.assets.get(name);
      if (!item) throw new Error(`missing guest runtime asset ${name}`);
      return `${base}assets/${encodeURIComponent(name)} ${item.sha256}`;
    };
    return `#!/bin/bash
set -Eeuo pipefail
BASE='${base}'
fail() {
  local code=$?
  curl -fsS -X POST "\${BASE}fail?message=$(printf '%s' 'guest provisioning failed' | sed 's/ /%20/g')" || true
  exit "\${code}"
}
trap fail ERR

mkdir -p /opt/agent-in-box/provision /etc/agent-in-box /run/agent-in-box /etc/lightdm/lightdm.conf.d
cat >/etc/lightdm/lightdm.conf.d/50-aib-autologin.conf <<'LIGHTDM'
[Seat:*]
autologin-user=aib
autologin-user-timeout=0
LIGHTDM
chmod 0644 /etc/lightdm/lightdm.conf.d/50-aib-autologin.conf
chmod 0700 /run/agent-in-box
fetch() {
  local name=$1 url=$2 expected=$3 dest=$4
  curl -fsSL "\${url%% *}" -o "\${dest}"
  echo "\${expected}  \${dest}" | sha256sum -c -
}

read -r GUEST_URL GUEST_SHA <<<'${asset("guest-agent")}'
fetch guest-agent "\${GUEST_URL}" "\${GUEST_SHA}" /usr/local/bin/agent-in-box-guest-agent
chmod 0755 /usr/local/bin/agent-in-box-guest-agent

read -r WORKER_URL WORKER_SHA <<<'${asset("worker-runtime.tar.gz")}'
fetch worker-runtime "\${WORKER_URL}" "\${WORKER_SHA}" /opt/agent-in-box/provision/worker-runtime.tar.gz
read -r NODE_URL NODE_SHA <<<'${asset("node-linux-x64.tar.xz")}'
fetch node "\${NODE_URL}" "\${NODE_SHA}" /opt/agent-in-box/provision/node-linux-x64.tar.xz
read -r PI_URL PI_SHA <<<'${asset("pi-coding-agent.tgz")}'
fetch pi "\${PI_URL}" "\${PI_SHA}" /opt/agent-in-box/provision/pi-coding-agent.tgz
read -r INSTALL_URL INSTALL_SHA <<<'${asset("install.sh")}'
fetch install.sh "\${INSTALL_URL}" "\${INSTALL_SHA}" /opt/agent-in-box/provision/install.sh
read -r UNIT_URL UNIT_SHA <<<'${asset("agent-in-box-worker.service")}'
fetch worker-unit "\${UNIT_URL}" "\${UNIT_SHA}" /opt/agent-in-box/provision/agent-in-box-worker.service
read -r ENV_URL ENV_SHA <<<'${asset("worker.env.example")}'
fetch worker-env "\${ENV_URL}" "\${ENV_SHA}" /opt/agent-in-box/provision/worker.env.example
read -r CUA_URL CUA_SHA <<<'${asset("cua-extension.js")}'
fetch cua "\${CUA_URL}" "\${CUA_SHA}" /opt/agent-in-box/provision/cua-extension.js
read -r AGENT_UNIT_URL AGENT_UNIT_SHA <<<'${asset("agent-in-box-guest-agent.service")}'
fetch agent-unit "\${AGENT_UNIT_URL}" "\${AGENT_UNIT_SHA}" /opt/agent-in-box/provision/agent-in-box-guest-agent.service

curl -fsSL "\${BASE}tokens/guest-agent.token" -o /etc/agent-in-box/guest-agent.token
chmod 0600 /etc/agent-in-box/guest-agent.token
cp /opt/agent-in-box/provision/agent-in-box-guest-agent.service /etc/systemd/system/agent-in-box-guest-agent.service

curl -fsSL "\${BASE}tokens/worker-rpc.token" -o /run/agent-in-box/rpc-token
chmod 0600 /run/agent-in-box/rpc-token

bash /opt/agent-in-box/provision/install.sh \\
  --node-archive /opt/agent-in-box/provision/node-linux-x64.tar.xz \\
  --node-sha256 "\${NODE_SHA}" \\
  --pi-package /opt/agent-in-box/provision/pi-coding-agent.tgz \\
  --pi-sha256 "\${PI_SHA}" \\
  --worker-bundle /opt/agent-in-box/provision/worker-runtime.tar.gz \\
  --worker-sha256 "\${WORKER_SHA}" \\
  --unit-file /opt/agent-in-box/provision/agent-in-box-worker.service \\
  --rpc-token-file /run/agent-in-box/rpc-token \\
  --cua-extension /opt/agent-in-box/provision/cua-extension.js

systemctl daemon-reload
systemctl enable --now agent-in-box-worker.service
systemctl start lightdm || true
for _ in $(seq 1 60); do
  test -S /tmp/.X11-unix/X0 && break
  sleep 2
done
systemctl enable --now agent-in-box-guest-agent.service
for _ in $(seq 1 30); do
  systemctl is-active --quiet agent-in-box-worker.service && \\
    systemctl is-active --quiet agent-in-box-guest-agent.service && break
  sleep 2
done
systemctl is-active --quiet agent-in-box-worker.service
systemctl is-active --quiet agent-in-box-guest-agent.service
curl -fsS -X POST "\${BASE}ready" >/dev/null
`;
  }

  private send(response: ServerResponse, status: number, contentType: string, body: string): void {
    response.writeHead(status, {
      "content-type": `${contentType}; charset=utf-8`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end(body);
  }

  private sendFile(response: ServerResponse, file: string, size: number): void {
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": size,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    createReadStream(file).pipe(response);
  }
}
