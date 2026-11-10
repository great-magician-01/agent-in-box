/**
 * Engine-neutral contracts. Pi is the first implementation candidate, not a hard dependency
 * of the domain, task service or UI.
 */

export type WorkerCapability = "filesystem" | "shell" | "computer_use" | "browser" | "read_only";

export interface WorkerSessionSpec {
  workerId: string;
  projectId: string;
  vmId: string;
  workspacePath: string;
  engineType: string;
  systemPrompt: string;
  capabilities: readonly WorkerCapability[];
  provider?: string;
  model?: string;
}

export interface WorkerInput {
  text: string;
  attachments?: readonly string[];
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

export interface WorkerEngine {
  readonly type: string;
  startSession(spec: WorkerSessionSpec): Promise<{ sessionId: string }>;
  prompt(sessionId: string, input: WorkerInput): Promise<void>;
  steer(sessionId: string, input: WorkerInput): Promise<"queued" | "handled">;
  followUp(sessionId: string, input: WorkerInput): Promise<"queued" | "handled">;
  abort(sessionId: string): Promise<void>;
  subscribe(sessionId: string, listener: (event: WorkerEngineEvent) => void): () => void;
  archive(sessionId: string): Promise<{ archiveRef: string; summary: string }>;
  resume(archiveRef: string): Promise<{ sessionId: string; mode: "native" | "summary" }>;
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
