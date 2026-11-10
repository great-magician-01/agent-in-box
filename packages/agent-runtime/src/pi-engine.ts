import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  type WorkerEngine,
  type WorkerEngineEvent,
  type WorkerInput,
  type WorkerSessionSpec,
} from "./index";
import { PiRpcProcess } from "./pi-rpc-process";

export interface PiWorkerEngineOptions {
  sessionRoot: string;
  piBinary?: string;
  extensionPath?: string;
  env?: NodeJS.ProcessEnv;
  provider?: string;
  model?: string;
  /** Test hook: arguments placed before the generated Pi CLI arguments. */
  argsPrefix?: readonly string[];
}

interface PiSession {
  process: PiRpcProcess;
  workerId: string;
  sessionFile: string | null;
}

interface PiState {
  sessionId?: string;
  sessionFile?: string;
}

const IMAGE_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

/**
 * Pi-backed full Worker. Each Worker owns one Pi subprocess and one persistent
 * session file; the engine never shares a session across projects or VMs.
 */
export class PiWorkerEngine implements WorkerEngine {
  readonly type = "pi-rpc";
  private readonly sessions = new Map<string, PiSession>();

  constructor(private readonly options: PiWorkerEngineOptions) {}

  async startSession(spec: WorkerSessionSpec): Promise<{ sessionId: string }> {
    const session = await this.startPi(spec);
    return { sessionId: this.registerSession(session) };
  }

  private async startPi(spec?: WorkerSessionSpec, resumeRef?: string): Promise<PiSession & { sessionId: string }> {
    const workerId = spec?.workerId ?? `resume-${Date.now()}`;
    const directory = path.join(this.options.sessionRoot, workerId);
    await mkdir(directory, { recursive: true });

    const args: string[] = [
      ...this.options.argsPrefix ?? [],
      "--mode", "rpc",
      "--session-dir", path.join(directory, "sessions"),
      "--name", workerId,
      "--no-mcp",
      "--no-skills",
      "--no-context-files",
      "--no-prompt-templates",
    ];
    if (resumeRef) {
      args.push("--session", resumeRef);
    } else {
      const provider = spec?.provider ?? this.options.provider;
      const model = spec?.model ?? this.options.model;
      if (provider) args.push("--provider", provider);
      if (model) args.push("--model", model);
    }
    if (spec?.systemPrompt) {
      args.push("--system-prompt", spec.systemPrompt);
    }
    if (this.options.extensionPath) {
      args.push("--extension", this.options.extensionPath);
    }
    if (spec && !spec.capabilities.includes("shell") && !spec.capabilities.includes("filesystem")) {
      // Keep explicitly registered CUA tools, but do not expose Pi's built-in
      // shell/read/write/edit tools to a Computer-Use-only Worker.
      args.push("--no-builtin-tools");
    }

    const process = new PiRpcProcess({
      command: this.options.piBinary ?? "pi",
      args,
      cwd: spec?.workspacePath,
      env: this.options.env,
    });
    await process.start();
    const state = await process.command<PiState>("get_state");
    const sessionId = state.sessionId ?? workerId;
    return { process, workerId, sessionFile: state.sessionFile ?? null, sessionId };
  }

  private registerSession(session: PiSession & { sessionId: string }): string {
    if (this.sessions.has(session.sessionId)) {
      throw new Error(`Pi session already registered: ${session.sessionId}`);
    }
    this.sessions.set(session.sessionId, session);
    return session.sessionId;
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
      ...(await this.readImages(input.attachments)),
    });
  }

  async steer(sessionId: string, input: WorkerInput): Promise<"queued" | "handled"> {
    const session = this.getSession(sessionId);
    const data = await session.process.command<{ disposition?: string }>("steer", {
      message: input.text,
      ...(await this.readImages(input.attachments)),
    });
    return data.disposition === "handled" ? "handled" : "queued";
  }

  async followUp(sessionId: string, input: WorkerInput): Promise<"queued" | "handled"> {
    const session = this.getSession(sessionId);
    const data = await session.process.command<{ disposition?: string }>("follow_up", {
      message: input.text,
      ...(await this.readImages(input.attachments)),
    });
    return data.disposition === "handled" ? "handled" : "queued";
  }

  async abort(sessionId: string): Promise<void> {
    await this.getSession(sessionId).process.command("abort");
  }

  subscribe(sessionId: string, listener: (event: WorkerEngineEvent) => void): () => void {
    const session = this.getSession(sessionId);
    return session.process.onEvent((event) => {
      const mapped = mapPiEvent(event);
      if (mapped) listener(mapped);
    });
  }

  async archive(sessionId: string): Promise<{ archiveRef: string; summary: string }> {
    const session = this.getSession(sessionId);
    const state = await session.process.command<PiState>("get_state");
    const archiveRef = state.sessionFile ?? session.sessionFile;
    if (!archiveRef) {
      throw new Error("Pi session has no persistent session file; refusing to claim a restorable archive");
    }
    const messages = await session.process.command<{ messages?: unknown[] }>("get_messages");
    const summary = summarizeMessages(messages.messages ?? [], sessionId);
    await session.process.close();
    this.sessions.delete(sessionId);
    return { archiveRef, summary };
  }

  async resume(archiveRef: string): Promise<{ sessionId: string; mode: "native" | "summary" }> {
    // A native Pi session restore either works or fails explicitly. There is no
    // fabricated lossless fallback; summary restoration is a separate path.
    const session = await this.startPi(undefined, archiveRef);
    const sessionId = this.registerSession(session);
    return { sessionId, mode: "native" };
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => session.process.close()));
    this.sessions.clear();
  }

  private async readImages(attachments?: readonly string[]): Promise<Record<string, unknown>> {
    if (!attachments || attachments.length === 0) return {};
    const images = [];
    for (const attachment of attachments) {
      const mimeType = IMAGE_MIME_TYPES[path.extname(attachment).toLowerCase()];
      if (!mimeType) {
        throw new Error(`Unsupported Worker image attachment: ${attachment}`);
      }
      const data = await readFile(attachment);
      images.push({ type: "image", data: data.toString("base64"), mimeType });
    }
    return { images };
  }
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
    case "process_exit":
      return { type: "session_ended", reason: "completed" };
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
