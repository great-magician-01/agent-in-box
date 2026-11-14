import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  inspectPluginPackage,
  isSafeRelativeEntryPath,
  resolvePluginEntry,
} from "@agent-in-box/plugin-runtime";
import {
  PI_ENGINE_VERSION,
  PI_SESSION_FORMAT_VERSION,
  type WorkerEngine,
  type WorkerEngineEvent,
  type WorkerInlineImage,
  type WorkerInput,
  type WorkerPluginPackageSpec,
  type WorkerSessionHandle,
  type WorkerSessionSpec,
} from "./index";
import { PiRpcProcess } from "./pi-rpc-process";

export interface PiWorkerEngineOptions {
  sessionRoot: string;
  piBinary?: string;
  /** Built-in Worker subagent support. Its path is never forwarded to children. */
  subagentExtensionPath?: string;
  /** Built-in plugin development tools, loaded only for Development Workers. */
  developmentExtensionPath?: string;
  /** Additional extensions, loaded before the legacy extensionPath. */
  extensionPaths?: readonly string[];
  extensionPath?: string;
  env?: NodeJS.ProcessEnv;
  provider?: string;
  model?: string;
  engineVersion?: string;
  sessionVersion?: string;
  /** Test hook: arguments placed before the generated Pi CLI arguments. */
  argsPrefix?: readonly string[];
}

interface SessionPlugin {
  pluginId: string;
  version: string;
  packageSha256: string;
  packageRoot: string;
  entryPath: string;
}

interface PiSession {
  process: PiRpcProcess;
  workerId: string;
  sessionFile: string | null;
  closing: boolean;
  homeDirectory: string;
  plugins?: SessionPlugin[];
}

interface PiState {
  sessionId?: string;
  sessionFile?: string;
}

interface SessionManifest {
  format: "agent-in-box.pi-session";
  version: 1;
  workerId: string;
  sessionId: string;
  engineType: "pi-rpc";
  engineVersion: string;
  sessionVersion: string;
  sessionFile: string;
  archiveFile?: string;
  sizeBytes?: number;
  sha256?: string;
  spec?: WorkerSessionSpec;
  plugins?: SessionPlugin[];
  createdAt: string;
}

const IMAGE_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

/**
 * Pi-backed full Worker. Each Worker owns one Pi subprocess, isolated HOME and
 * persistent session directory; sessions are never shared across projects/VMs.
 */
export class PiWorkerEngine implements WorkerEngine {
  readonly type = "pi-rpc";
  private readonly sessions = new Map<string, PiSession>();
  private readonly engineVersion: string;
  private readonly sessionVersion: string;

  constructor(private readonly options: PiWorkerEngineOptions) {
    this.engineVersion = options.engineVersion ?? PI_ENGINE_VERSION;
    this.sessionVersion = options.sessionVersion ?? PI_SESSION_FORMAT_VERSION;
  }

  async startSession(spec: WorkerSessionSpec): Promise<WorkerSessionHandle> {
    this.assertCompatible(spec);
    const session = await this.startPi(spec);
    try {
      return this.registerSession(session, false);
    } catch (error) {
      await session.process.close().catch(() => undefined);
      throw error;
    }
  }

  private assertCompatible(spec: WorkerSessionSpec): void {
    if (spec.engineType !== this.type) {
      throw new Error(`Unsupported Worker engine: ${spec.engineType}`);
    }
    if (spec.engineVersion && spec.engineVersion !== this.engineVersion) {
      throw new Error(
        `Incompatible Pi engine version ${spec.engineVersion}; required ${this.engineVersion}`,
      );
    }
    if (spec.sessionVersion && spec.sessionVersion !== this.sessionVersion) {
      throw new Error(
        `Incompatible Pi session format ${spec.sessionVersion}; required ${this.sessionVersion}`,
      );
    }
  }

  private async startPi(
    spec?: WorkerSessionSpec,
    resumeRef?: string,
  ): Promise<PiSession & WorkerSessionHandle> {
    const resumed = resumeRef ? await this.resolveResumeReference(resumeRef, spec) : null;
    const workerId = spec?.workerId ?? resumed?.manifest.workerId;
    if (!workerId) throw new Error("A workerId is required to start or resume a Pi session");
    assertSafeId(workerId, "workerId");
    if (resumed && resumed.manifest.workerId !== workerId) {
      throw new Error("Pi session archive belongs to a different Worker");
    }
    if (spec) this.assertCompatible(spec);

    const directory = path.join(this.options.sessionRoot, workerId);
    const homeDirectory = path.join(directory, "home");
    await mkdir(path.join(directory, "sessions"), { recursive: true, mode: 0o700 });
    await mkdir(homeDirectory, { recursive: true, mode: 0o700 });
    if (spec?.modelBroker) await this.writeModelsConfig(homeDirectory, spec);
    const sessionPlugins = spec?.pluginPackages
      ? await materializePluginPackages(directory, spec.pluginPackages)
      : await verifySessionPlugins(directory, resumed?.manifest.plugins);

    const args: string[] = [
      ...(this.options.argsPrefix ?? []),
      "--mode",
      "rpc",
      "--session-dir",
      path.join(directory, "sessions"),
      "--name",
      workerId,
      "--no-skills",
      "--no-context-files",
      "--no-prompt-templates",
    ];
    const effectiveSpec = spec ?? resumed?.manifest.spec;
    const mcpEnabled = effectiveSpec?.mcpEnabled ?? false;
    if (!mcpEnabled) args.push("--no-mcp");
    if (resumed) {
      args.push("--session", resumed.launchFile);
    } else {
      const provider = spec?.modelBroker?.provider ?? spec?.provider ?? this.options.provider;
      const model = spec?.modelBroker?.model ?? spec?.model ?? this.options.model;
      if (provider) args.push("--provider", provider);
      if (model) args.push("--model", model);
    }
    if (spec?.systemPrompt) {
      args.push("--system-prompt", spec.systemPrompt);
    }
    const extensionPaths = [
      ...new Set([
        ...(this.options.extensionPaths ?? []),
        ...sessionPlugins.map((plugin) => plugin.entryPath),
        ...(this.options.extensionPath ? [this.options.extensionPath] : []),
      ]),
    ];
    for (const extensionPath of [
      ...(this.options.subagentExtensionPath ? [this.options.subagentExtensionPath] : []),
      ...(effectiveSpec?.pluginDevelopment && this.options.developmentExtensionPath
        ? [this.options.developmentExtensionPath]
        : []),
      ...extensionPaths,
    ]) {
      args.push("--extension", extensionPath);
    }
    const noBuiltinTools = Boolean(
      effectiveSpec &&
      !effectiveSpec.capabilities.includes("shell") &&
      !effectiveSpec.capabilities.includes("filesystem"),
    );
    if (noBuiltinTools) {
      // Keep explicitly registered CUA tools, but do not expose Pi's built-in
      // shell/read/write/edit tools to a Computer-Use-only Worker.
      args.push("--no-builtin-tools");
    }

    const process = new PiRpcProcess({
      command: this.options.piBinary ?? "pi",
      args,
      cwd: spec?.workspacePath ?? resumed?.manifest.spec?.workspacePath,
      env: {
        ...globalThis.process.env,
        ...this.options.env,
        HOME: homeDirectory,
        USERPROFILE: homeDirectory,
        ...(this.options.subagentExtensionPath
          ? {
              AGENT_IN_BOX_SUBAGENT_CHILD_ARGS: JSON.stringify(
                subagentChildArgs(extensionPaths, mcpEnabled, noBuiltinTools),
              ),
            }
          : {}),
        ...(spec?.computerUse
          ? {
              AGENT_IN_BOX_CUA_URL: spec.computerUse.baseUrl,
              AGENT_IN_BOX_CUA_TOKEN: spec.computerUse.token,
            }
          : {}),
        ...(spec?.pluginDevelopment
          ? {
              AGENT_IN_BOX_PLUGIN_DEV_URL: spec.pluginDevelopment.baseUrl,
              AGENT_IN_BOX_PLUGIN_DEV_TOKEN: spec.pluginDevelopment.token,
            }
          : {}),
      },
    });
    await process.start();
    try {
      const state = await process.command<PiState>("get_state");
      const sessionId = state.sessionId ?? workerId;
      const sessionFile = state.sessionFile ? path.resolve(state.sessionFile) : null;
      const handle: WorkerSessionHandle = {
        sessionId,
        ...(sessionFile ? { archiveRef: sessionFile } : {}),
        engineVersion: this.engineVersion,
        sessionVersion: this.sessionVersion,
      };
      const session = {
        process,
        workerId,
        sessionFile,
        closing: false,
        homeDirectory,
        plugins: sessionPlugins,
        ...handle,
      };
      await this.writeSessionManifest(session, spec ?? resumed?.manifest.spec);
      return session;
    } catch (error) {
      // The child may already hold model Broker credentials in its environment.
      // Never leak one orphan Pi process per failed start/retry.
      await process.close().catch(() => undefined);
      throw error;
    }
  }

  private async writeModelsConfig(homeDirectory: string, spec: WorkerSessionSpec): Promise<void> {
    const broker = spec.modelBroker;
    if (!broker) return;
    const url = new URL(broker.baseUrl);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      throw new Error("Model Broker URL must be HTTP(S) without embedded credentials");
    }
    assertSafeId(broker.provider, "model provider");
    if (!broker.token || broker.token.length > 4096 || !broker.model || broker.model.length > 200) {
      throw new Error("Invalid Model Broker session configuration");
    }
    const directory = path.join(homeDirectory, ".pi", "agent");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const models = {
      $schema: "https://pi.dev/schemas/models.schema.json",
      providers: {
        [broker.provider]: {
          baseUrl: broker.baseUrl.replace(/\/$/, ""),
          api: broker.api,
          apiKey: broker.token,
          models: [
            {
              id: broker.model,
              name: broker.model,
              input: broker.input ?? ["text", "image"],
              reasoning: broker.reasoning === true,
            },
          ],
        },
      },
    };
    await atomicWrite(path.join(directory, "models.json"), `${JSON.stringify(models, null, 2)}\n`);
  }

  private async writeSessionManifest(
    session: PiSession & WorkerSessionHandle,
    spec?: WorkerSessionSpec,
  ): Promise<void> {
    if (!session.sessionFile) return;
    const manifest: SessionManifest = {
      format: "agent-in-box.pi-session",
      version: 1,
      workerId: session.workerId,
      sessionId: session.sessionId,
      engineType: "pi-rpc",
      engineVersion: this.engineVersion,
      sessionVersion: this.sessionVersion,
      sessionFile: session.sessionFile,
      ...(spec ? { spec: sanitizeSpec(spec) } : {}),
      ...(session.plugins ? { plugins: session.plugins } : {}),
      createdAt: new Date().toISOString(),
    };
    await atomicWrite(
      path.join(this.options.sessionRoot, session.workerId, "session.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  }

  private registerSession(
    session: PiSession & WorkerSessionHandle,
    replace: boolean,
  ): WorkerSessionHandle {
    const existing = this.sessions.get(session.sessionId);
    if (existing && !replace)
      throw new Error(`Pi session already registered: ${session.sessionId}`);
    if (existing) void existing.process.close();
    this.sessions.set(session.sessionId, session);
    return {
      sessionId: session.sessionId,
      ...(session.sessionFile ? { archiveRef: session.sessionFile } : {}),
      engineVersion: this.engineVersion,
      sessionVersion: this.sessionVersion,
    };
  }

  private getSession(sessionId: string): PiSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown Pi Worker session: ${sessionId}`);
    return session;
  }

  async prompt(sessionId: string, input: WorkerInput): Promise<void> {
    const session = this.getSession(sessionId);
    await session.process.command("prompt", {
      message: input.text,
      ...(await this.readImages(input.attachments, input.images)),
    });
  }

  async steer(sessionId: string, input: WorkerInput): Promise<"queued" | "handled"> {
    const session = this.getSession(sessionId);
    const data = await session.process.command<{ disposition?: string }>("steer", {
      message: input.text,
      ...(await this.readImages(input.attachments, input.images)),
    });
    return data.disposition === "handled" ? "handled" : "queued";
  }

  async followUp(sessionId: string, input: WorkerInput): Promise<"queued" | "handled"> {
    const session = this.getSession(sessionId);
    const data = await session.process.command<{ disposition?: string }>("follow_up", {
      message: input.text,
      ...(await this.readImages(input.attachments, input.images)),
    });
    return data.disposition === "handled" ? "handled" : "queued";
  }

  async abort(sessionId: string): Promise<void> {
    await this.getSession(sessionId).process.command("abort");
  }

  subscribe(sessionId: string, listener: (event: WorkerEngineEvent) => void): () => void {
    const session = this.getSession(sessionId);
    return session.process.onEvent((event) => {
      if (event.type === "process_exit") {
        if (session.closing || event.expected === true) {
          listener({ type: "session_ended", reason: "completed" });
        } else {
          listener({
            type: "session_failed",
            message: `Pi RPC exited unexpectedly (code=${String(event.code)}, signal=${String(event.signal)})`,
          });
        }
        return;
      }
      const mapped = mapPiEvent(event);
      if (mapped) listener(mapped);
    });
  }

  async archive(sessionId: string): Promise<{ archiveRef: string; summary: string }> {
    const session = this.getSession(sessionId);
    const state = await session.process.command<PiState>("get_state");
    const liveFile = state.sessionFile ? path.resolve(state.sessionFile) : session.sessionFile;
    if (!liveFile) {
      throw new Error(
        "Pi session has no persistent session file; refusing to claim a restorable archive",
      );
    }
    const messages = await session.process.command<{ messages?: unknown[] }>("get_messages");
    const summary = summarizeMessages(messages.messages ?? [], sessionId);
    session.closing = true;
    await session.process.close();
    this.sessions.delete(sessionId);

    const liveManifest = await this.readManifest(
      path.join(this.options.sessionRoot, session.workerId, "session.json"),
    );
    this.validateManifest(liveManifest);
    if (path.resolve(liveManifest.sessionFile) !== liveFile) {
      throw new Error("Pi live session file does not match its manifest");
    }
    await assertRegularFile(liveFile);
    const backupDirectory = path.join(this.options.sessionRoot, "backups");
    await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
    const archiveRef = path.join(
      backupDirectory,
      `${session.workerId}-${Date.now()}-${randomUUID()}.jsonl`,
    );
    await copyFile(liveFile, archiveRef, constants.COPYFILE_EXCL);
    const bytes = await readFile(archiveRef);
    const manifest: SessionManifest = {
      ...liveManifest,
      sessionFile: archiveRef,
      archiveFile: archiveRef,
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      createdAt: new Date().toISOString(),
    };
    await atomicWrite(`${archiveRef}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
    await rm(path.join(session.homeDirectory, ".pi", "agent", "models.json"), { force: true });
    return { archiveRef, summary };
  }

  async resume(
    archiveRef: string,
    spec?: WorkerSessionSpec,
  ): Promise<WorkerSessionHandle & { mode: "native" | "summary" }> {
    // Native restore either works or fails explicitly. Summary restoration is a
    // separate host-driven startSession path, never a fabricated lossless fallback.
    const session = await this.startPi(spec, archiveRef);
    const handle = this.registerSession(session, true);
    return { ...handle, mode: "native" };
  }

  private async resolveResumeReference(
    archiveRef: string,
    spec?: WorkerSessionSpec,
  ): Promise<{ manifest: SessionManifest; launchFile: string }> {
    if (!path.isAbsolute(archiveRef)) throw new Error("Pi session reference must be absolute");
    const resolved = path.resolve(archiveRef);
    assertInside(this.options.sessionRoot, resolved);
    await assertRegularFile(resolved);
    const backupDirectory = path.join(this.options.sessionRoot, "backups");
    const isBackup = isInside(backupDirectory, resolved);
    let manifest: SessionManifest;
    let launchFile = resolved;
    if (isBackup) {
      manifest = await this.readManifest(`${resolved}.manifest.json`);
      this.validateManifest(manifest);
      if (path.resolve(manifest.sessionFile) !== resolved || manifest.archiveFile !== resolved) {
        throw new Error("Pi archive manifest does not match the requested archive");
      }
      const bytes = await readFile(resolved);
      if (
        manifest.sizeBytes !== bytes.byteLength ||
        manifest.sha256 !== createHash("sha256").update(bytes).digest("hex")
      ) {
        throw new Error("Pi archive checksum or size does not match its manifest");
      }
    } else {
      const workerId =
        spec?.workerId ?? path.relative(this.options.sessionRoot, resolved).split(path.sep)[0];
      if (!workerId) throw new Error("Cannot determine the Worker for a live Pi session");
      assertSafeId(workerId, "workerId");
      manifest = await this.readManifest(
        path.join(this.options.sessionRoot, workerId, "session.json"),
      );
      this.validateManifest(manifest);
      if (path.resolve(manifest.sessionFile) !== resolved) {
        throw new Error("Pi live session reference does not match its manifest");
      }
    }
    if (spec && manifest.workerId !== spec.workerId) {
      throw new Error("Pi session archive belongs to a different Worker");
    }

    if (isBackup) {
      const restoreDirectory = path.join(this.options.sessionRoot, manifest.workerId, "sessions");
      await mkdir(restoreDirectory, { recursive: true, mode: 0o700 });
      launchFile = path.join(restoreDirectory, `restored-${Date.now()}-${randomUUID()}.jsonl`);
      await copyFile(resolved, launchFile, constants.COPYFILE_EXCL);
    }
    return { manifest, launchFile };
  }

  private async readManifest(file: string): Promise<SessionManifest> {
    await assertRegularFile(file);
    const handle = await open(file, constants.O_RDONLY | noFollowFlag());
    try {
      const content = await handle.readFile("utf8");
      return JSON.parse(content) as SessionManifest;
    } finally {
      await handle.close();
    }
  }

  private validateManifest(manifest: SessionManifest): void {
    if (
      manifest?.format !== "agent-in-box.pi-session" ||
      manifest.version !== 1 ||
      manifest.engineType !== this.type ||
      manifest.engineVersion !== this.engineVersion ||
      manifest.sessionVersion !== this.sessionVersion
    ) {
      throw new Error(
        `Incompatible Pi session archive; required engine=${this.engineVersion}, session=${this.sessionVersion}`,
      );
    }
  }

  async dispose(): Promise<void> {
    const sessions = [...this.sessions.values()];
    for (const session of sessions) session.closing = true;
    await Promise.all(sessions.map((session) => session.process.close()));
    await Promise.all(
      sessions.map((session) =>
        rm(path.join(session.homeDirectory, ".pi", "agent", "models.json"), { force: true }),
      ),
    );
    this.sessions.clear();
  }

  private async readImages(
    attachments?: readonly string[],
    inline?: readonly WorkerInlineImage[],
  ): Promise<Record<string, unknown>> {
    const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
    for (const attachment of attachments ?? []) {
      if (typeof attachment !== "string" || !path.isAbsolute(attachment)) {
        throw new Error("Worker image attachments must be absolute guest-local paths");
      }
      const mimeType = IMAGE_MIME_TYPES[path.extname(attachment).toLowerCase()];
      if (!mimeType) {
        throw new Error(`Unsupported Worker image attachment: ${attachment}`);
      }
      const data = await readFile(attachment);
      if (data.byteLength > 20 * 1024 * 1024) {
        throw new Error(`Worker image attachment exceeds 20 MiB: ${attachment}`);
      }
      images.push({ type: "image", data: data.toString("base64"), mimeType });
    }
    for (const image of inline ?? []) {
      if (!["image/png", "image/jpeg", "image/webp"].includes(image.mimeType)) {
        throw new Error(`Unsupported inline image type: ${image.mimeType}`);
      }
      const bytes = Buffer.from(image.data, "base64");
      if (bytes.byteLength === 0 || bytes.byteLength > 12 * 1024 * 1024) {
        throw new Error("Inline Worker image must be between 1 byte and 12 MiB");
      }
      images.push({ type: "image", data: image.data, mimeType: image.mimeType });
    }
    return images.length > 0 ? { images } : {};
  }
}

function subagentChildArgs(
  extensionPaths: readonly string[],
  mcpEnabled: boolean,
  noBuiltinTools: boolean,
): string[] {
  const args = ["--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates"];
  for (const extensionPath of extensionPaths) args.push("--extension", extensionPath);
  if (mcpEnabled) {
    // --no-extensions disables built-in discovery, so restore only the MCP
    // facilities that the parent session explicitly enabled.
    args.push("--extension", "builtin:codemode", "--extension", "builtin:mcp");
  } else {
    args.push("--no-mcp");
  }
  if (noBuiltinTools) args.push("--no-builtin-tools");
  return args;
}

function mapPiEvent(event: Record<string, unknown>): WorkerEngineEvent | null {
  switch (event.type) {
    case "message_update": {
      const update = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
      return update?.type === "text_delta" && typeof update.delta === "string"
        ? { type: "text_delta", delta: update.delta }
        : null;
    }
    case "tool_execution_start":
      return { type: "tool_started", toolName: String(event.toolName), input: event.args };
    case "tool_execution_end":
      return {
        type: "tool_finished",
        toolName: String(event.toolName),
        output: event.result,
        isError: event.isError === true,
      };
    case "agent_settled":
      return { type: "turn_finished" };
    case "protocol_error":
      return { type: "session_failed", message: String(event.message) };
    default:
      return null;
  }
}

function summarizeMessages(messages: unknown[], sessionId: string): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: string; content?: unknown };
    if (message?.role !== "assistant") continue;
    if (typeof message.content === "string") return message.content.slice(0, 2000);
    if (Array.isArray(message.content)) {
      const text = message.content
        .filter((block) => (block as { type?: string }).type === "text")
        .map((block) => String((block as { text?: string }).text ?? ""))
        .join("\n");
      if (text) return text.slice(0, 2000);
    }
  }
  return `Pi Worker session ${sessionId} archived with ${messages.length} messages; no assistant text summary available.`;
}

async function materializePluginPackages(
  sessionDirectory: string,
  packages: readonly WorkerPluginPackageSpec[],
): Promise<SessionPlugin[]> {
  if (packages.length > 32) throw new Error("Too many Worker plugin packages");
  const result: SessionPlugin[] = [];
  for (const plugin of packages) {
    assertSafeId(plugin.pluginId, "Worker plugin ID");
    if (!/^[A-Za-z0-9][A-Za-z0-9.+-]{0,127}$/.test(plugin.version)) {
      throw new Error("Invalid Worker plugin version");
    }
    if (!/^[a-f0-9]{64}$/.test(plugin.packageSha256)) {
      throw new Error("Invalid Worker plugin package hash");
    }
    if (!Array.isArray(plugin.files) || plugin.files.length > 2048) {
      throw new Error("Invalid Worker plugin file list");
    }
    const finalRoot = path.join(sessionDirectory, "plugins", plugin.pluginId, plugin.version);
    const staging = path.join(
      sessionDirectory,
      "plugins",
      ".staging",
      `${process.pid}-${randomUUID()}`,
    );
    await mkdir(staging, { recursive: true, mode: 0o700 });
    try {
      let totalBytes = 0;
      for (const file of plugin.files) {
        if (!isSafeRelativeEntryPath(file.path) || typeof file.dataBase64 !== "string") {
          throw new Error("Unsafe Worker plugin file path or content");
        }
        const bytes = Buffer.from(file.dataBase64, "base64");
        if (bytes.toString("base64") !== file.dataBase64 || bytes.byteLength > 2 * 1024 * 1024) {
          throw new Error("Invalid Worker plugin base64 content");
        }
        totalBytes += bytes.byteLength;
        if (totalBytes > 4 * 1024 * 1024) throw new Error("Worker plugin package is too large");
        const target = path.join(staging, ...file.path.split("/"));
        assertInside(staging, target);
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, bytes, { flag: "wx", mode: 0o700 });
      }
      const inspected = await inspectPluginPackage(staging, {
        maxFileBytes: 2 * 1024 * 1024,
        maxTotalBytes: 4 * 1024 * 1024,
      });
      if (
        inspected.packageSha256 !== plugin.packageSha256 ||
        inspected.manifest.id !== plugin.pluginId ||
        inspected.manifest.version !== plugin.version ||
        inspected.manifest.entrypoints.worker !== plugin.entryPath
      ) {
        throw new Error("Worker plugin package identity or hash mismatch");
      }
      const existing = await inspectPluginPackage(finalRoot, {
        maxFileBytes: 2 * 1024 * 1024,
        maxTotalBytes: 4 * 1024 * 1024,
      }).catch(() => null);
      if (existing?.packageSha256 === plugin.packageSha256) {
        await rm(staging, { recursive: true, force: true });
      } else {
        // This is a derived, per-Worker cache directory, never a caller path.
        await rm(finalRoot, { recursive: true, force: true });
        await mkdir(path.dirname(finalRoot), { recursive: true, mode: 0o700 });
        await rename(staging, finalRoot);
      }
      result.push({
        pluginId: plugin.pluginId,
        version: plugin.version,
        packageSha256: plugin.packageSha256,
        packageRoot: finalRoot,
        entryPath: await resolvePluginEntry(finalRoot, "worker"),
      });
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  return result;
}

async function verifySessionPlugins(
  sessionDirectory: string,
  plugins: SessionPlugin[] | undefined,
): Promise<SessionPlugin[]> {
  if (!plugins) return [];
  const result: SessionPlugin[] = [];
  for (const plugin of plugins) {
    assertSafeId(plugin.pluginId, "Worker plugin ID");
    const packageRoot = path.join(sessionDirectory, "plugins", plugin.pluginId, plugin.version);
    assertInside(sessionDirectory, packageRoot);
    const inspected = await inspectPluginPackage(packageRoot, {
      maxFileBytes: 2 * 1024 * 1024,
      maxTotalBytes: 4 * 1024 * 1024,
    });
    if (
      inspected.packageSha256 !== plugin.packageSha256 ||
      inspected.manifest.id !== plugin.pluginId ||
      inspected.manifest.version !== plugin.version
    ) {
      throw new Error(`Worker plugin ${plugin.pluginId} failed session integrity verification`);
    }
    result.push({
      ...plugin,
      packageRoot,
      entryPath: await resolvePluginEntry(packageRoot, "worker"),
    });
  }
  return result;
}

function sanitizeSpec(spec: WorkerSessionSpec): WorkerSessionSpec {
  // Never write short-lived broker tokens into the persistent session manifest.
  return {
    workerId: spec.workerId,
    projectId: spec.projectId,
    vmId: spec.vmId,
    workspacePath: spec.workspacePath,
    engineType: spec.engineType,
    ...(spec.engineVersion !== undefined ? { engineVersion: spec.engineVersion } : {}),
    ...(spec.sessionVersion !== undefined ? { sessionVersion: spec.sessionVersion } : {}),
    systemPrompt: spec.systemPrompt,
    capabilities: [...spec.capabilities],
    mcpEnabled: spec.mcpEnabled === true,
    ...(spec.pluginSnapshotId ? { pluginSnapshotId: spec.pluginSnapshotId } : {}),
    ...(spec.provider !== undefined ? { provider: spec.provider } : {}),
    ...(spec.model !== undefined ? { model: spec.model } : {}),
  };
}

function assertSafeId(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function assertInside(root: string, candidate: string): void {
  if (!isInside(root, candidate))
    throw new Error("Pi session reference escapes the runtime session root");
}

async function assertRegularFile(file: string): Promise<void> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Not a regular file: ${file}`);
}

function noFollowFlag(): number {
  return constants.O_NOFOLLOW ?? 0;
}

async function atomicWrite(file: string, content: string): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
  try {
    await rename(temporary, file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "EPERM") {
      await rm(temporary, { force: true });
      throw error;
    }
    await rm(file, { force: true });
    await rename(temporary, file);
  }
}
