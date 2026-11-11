/**
 * Engine-neutral contracts. Pi is the first implementation candidate, not a hard dependency
 * of the domain, task service or UI.
 */

export const WORKER_RPC_PROTOCOL_VERSION = "0.1.0" as const;
export const PI_ENGINE_VERSION = "1.5.1" as const;
export const PI_SESSION_FORMAT_VERSION = "1" as const;

export type WorkerCapability = "filesystem" | "shell" | "computer_use" | "browser" | "read_only";
export type WorkerModelApi = "openai-completions" | "anthropic-messages";

/** Short-lived, host-issued broker access. The upstream credential never enters this object. */
export interface WorkerModelBrokerSpec {
  baseUrl: string;
  token: string;
  provider: string;
  model: string;
  api: WorkerModelApi;
  reasoning?: boolean;
}

/**
 * Short-lived, task-scoped access to the host Computer Use broker. Like the
 * Model Broker token, this is not an upstream credential and is never archived.
 */
export interface WorkerComputerUseSpec {
  baseUrl: string;
  token: string;
}

export interface WorkerSessionSpec {
  workerId: string;
  projectId: string;
  vmId: string;
  workspacePath: string;
  engineType: string;
  engineVersion?: string;
  sessionVersion?: string;
  systemPrompt: string;
  capabilities: readonly WorkerCapability[];
  provider?: string;
  model?: string;
  modelBroker?: WorkerModelBrokerSpec;
  computerUse?: WorkerComputerUseSpec;
}

export interface WorkerInlineImage {
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  data: string;
}

export interface WorkerInput {
  text: string;
  /** Guest-local absolute image paths. */
  attachments?: readonly string[];
  /** Host-captured images sent inline for resume/environment injection. */
  images?: readonly WorkerInlineImage[];
}

export type WorkerEngineEvent =
  | { type: "session_started"; sessionId: string }
  | { type: "text_delta"; delta: string }
  | { type: "tool_started"; toolName: string; input: unknown }
  | { type: "tool_finished"; toolName: string; output: unknown; isError: boolean }
  | { type: "waiting_approval"; reason: string }
  | { type: "turn_finished" }
  | { type: "session_failed"; message: string }
  | { type: "session_ended"; reason: "completed" | "cancelled" | "failed" };

export interface WorkerSessionHandle {
  sessionId: string;
  /** Opaque to the host. It is a guest-local live or archived session reference. */
  archiveRef?: string;
  engineVersion?: string;
  sessionVersion?: string;
}

export interface WorkerEngine {
  readonly type: string;
  startSession(spec: WorkerSessionSpec): Promise<WorkerSessionHandle>;
  prompt(sessionId: string, input: WorkerInput): Promise<void>;
  steer(sessionId: string, input: WorkerInput): Promise<"queued" | "handled">;
  followUp(sessionId: string, input: WorkerInput): Promise<"queued" | "handled">;
  abort(sessionId: string): Promise<void>;
  subscribe(sessionId: string, listener: (event: WorkerEngineEvent) => void): () => void;
  archive(sessionId: string): Promise<{ archiveRef: string; summary: string }>;
  resume(
    archiveRef: string,
    spec?: WorkerSessionSpec,
  ): Promise<WorkerSessionHandle & { mode: "native" | "summary" }>;
  /** Release engine-owned processes/files. Optional for remote engine adapters. */
  dispose?(): Promise<void>;
}

export interface WorkerEngineRegistry {
  register(engine: WorkerEngine): void;
  get(type: string): WorkerEngine | undefined;
  list(): readonly WorkerEngine[];
}

export function createWorkerEngineRegistry(): WorkerEngineRegistry {
  const engines = new Map<string, WorkerEngine>();
  return {
    register(engine) {
      if (engines.has(engine.type)) {
        throw new Error(`Worker engine already registered: ${engine.type}`);
      }
      engines.set(engine.type, engine);
    },
    get(type) {
      return engines.get(type);
    },
    list() {
      return [...engines.values()];
    },
  };
}

export { PiRpcProcess } from "./pi-rpc-process";
export { PiWorkerEngine, type PiWorkerEngineOptions } from "./pi-engine";
export { assertPiLaunchSupported, resolvePiLaunch, type PiLaunchCommand } from "./pi-launch";
export {
  WorkerRpcClient,
  WorkerRpcError,
  type WorkerRpcClientOptions,
  type WorkerSessionView,
} from "./worker-rpc-client";
export { WorkerRpcServer, type WorkerRpcServerOptions } from "./worker-rpc-server";
