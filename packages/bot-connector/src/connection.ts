/**
 * Generic long-connection framework for local-first bot ingress.
 *
 * Responsibilities:
 * - WebSocket lifecycle state machine (disconnected/connecting/connected/degraded)
 * - heartbeat watchdog and exponential-backoff reconnect
 * - idempotent inbound admission: persistent dedupe check -> local ingress queue
 * - outbound send / status / active disconnect
 *
 * AI work must never run inside the WebSocket callback. Adapters admit an
 * event into the ingress queue; configured listeners consume it from a
 * separate asynchronous dispatch loop.
 */

import {
  type BotConnectionState,
  type BotConnector,
  type BotConnectorStatus,
  type BotPlatform,
  type InboundBotMessage,
  type OutboundBotMessage,
} from "./contracts";
import {
  InboundPipeline,
  type AcceptInboundResult,
  type DedupeStore,
  type InboundEventDraft,
  type InboundPipelineOptions,
  type IngressMetrics,
} from "./ingress";
import { NOOP_BOT_LOGGER, safeErrorMessage, type BotConnectorLogger } from "./logger";
import { computeBackoffDelay, resolveReconnectPolicy, type ReconnectPolicy } from "./reconnect";
import type { WsCloseInfo, WsConnectOptions, WsConnector, WsData, WsSocket } from "./ws";

export { InMemoryDedupeStore, IngressQueue } from "./ingress";
export type {
  AcceptInboundResult,
  DedupeStore,
  InboundEventDraft,
  IngressMetrics,
} from "./ingress";

/** Fatal configuration/auth problem: reconnect would only repeat the same failure. */
export class TerminalBotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalBotError";
  }
}

export function isTerminalBotError(error: unknown): error is TerminalBotError {
  return error instanceof TerminalBotError;
}

export interface ResolvedBotConnection {
  url: string;
  headers?: Readonly<Record<string, string>>;
}

export interface ProtocolSendTransport {
  sendRaw(data: WsData): void;
  readonly ready: boolean;
}

export interface ProtocolContext {
  readonly signal: AbortSignal;
  sendRaw(data: WsData): void;
  /** Dedupe + enqueue. Resolves only after durable admission (or duplicate detection). */
  acceptInbound(draft: InboundEventDraft): Promise<AcceptInboundResult>;
  /** Called by the adapter once handshake/authentication is complete. */
  markReady(): void;
  /** Heartbeat interval and sender. May be called again when server updates config. */
  setHeartbeat(intervalMs: number, beat: () => void): void;
  /** Server-suggested reconnect floor (for example Feishu ClientConfig). */
  setReconnectBaseDelay(delayMs: number): void;
  requestReconnect(reason: string): void;
}

export interface BotProtocolSession {
  onOpen(): void | Promise<void>;
  onMessage(data: WsData): void | Promise<void>;
  onClose?(info: WsCloseInfo): void;
  dispose?(): void;
}

export interface BotProtocol {
  readonly platform: BotPlatform;
  /** Bootstrap (endpoint/token exchange) followed by a WebSocket URL. */
  resolveConnection(signal: AbortSignal): Promise<ResolvedBotConnection>;
  createSession(context: ProtocolContext, connection: ResolvedBotConnection): BotProtocolSession;
  sendMessage?(message: OutboundBotMessage, transport: ProtocolSendTransport): Promise<void>;
  /** Platforms whose close codes mean "do not retry" (bad token/intents/shard). */
  isTerminalClose?(code: number): boolean;
  /** Minimum delay for specific close codes, e.g. QQ 4008 rate limiting. */
  getCloseReconnectDelayMs?(code: number): number | undefined;
}

export interface BotConnectionMetrics extends IngressMetrics {
  connectAttempts: number;
  reconnectsScheduled: number;
  terminalErrors: number;
}

export interface ManagedBotConnectionOptions {
  protocol: BotProtocol;
  deviceId: string;
  wsConnector: WsConnector;
  dedupeStore?: DedupeStore;
  reconnect?: Partial<ReconnectPolicy>;
  logger?: BotConnectorLogger;
  ingressCapacity?: number;
  /**
   * When false, listeners registered through `onMessage` are not dispatched
   * automatically; the caller must consume `drainIngress()` itself.
   */
  autoDispatchIngress?: boolean;
  heartbeatTimeoutMs?: number;
  now?: () => Date;
  random?: () => number;
}

export class ManagedBotConnection implements BotConnector {
  readonly platform: BotPlatform;

  private readonly protocol: BotProtocol;
  private readonly wsConnector: WsConnector;
  private readonly reconnectPolicy: ReconnectPolicy;
  private readonly logger: BotConnectorLogger;
  private readonly heartbeatTimeoutOverrideMs: number | undefined;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly pipeline: InboundPipeline;

  private readonly metrics = {
    connectAttempts: 0,
    reconnectsScheduled: 0,
    terminalErrors: 0,
  };

  private state: BotConnectionState = "disconnected";
  private stopped = true;
  private runId = 0;
  private lastConnectedAt: string | null = null;
  private lastError: string | null = null;

  private abortController = new AbortController();
  private socket: WsSocket | null = null;
  private session: BotProtocolSession | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatIntervalMs: number | null = null;
  private heartbeatBeat: (() => void) | null = null;
  private reconnectBaseDelayMs = 0;
  private failureCount = 0;
  private messageChain: Promise<void> = Promise.resolve();

  private connectPromise: Promise<void> | null = null;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((error: Error) => void) | null = null;

  private readonly protocolContext: ProtocolContext;

  constructor(options: ManagedBotConnectionOptions) {
    this.platform = options.protocol.platform;
    this.protocol = options.protocol;
    this.wsConnector = options.wsConnector;
    this.reconnectPolicy = resolveReconnectPolicy(options.reconnect);
    this.logger = options.logger ?? NOOP_BOT_LOGGER;
    this.heartbeatTimeoutOverrideMs = options.heartbeatTimeoutMs;
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;

    const pipelineOptions: InboundPipelineOptions = {
      platform: this.platform,
      deviceId: options.deviceId,
      logger: this.logger,
    };
    if (options.dedupeStore) pipelineOptions.dedupeStore = options.dedupeStore;
    if (options.ingressCapacity !== undefined)
      pipelineOptions.ingressCapacity = options.ingressCapacity;
    if (options.autoDispatchIngress !== undefined) {
      pipelineOptions.autoDispatchIngress = options.autoDispatchIngress;
    }
    this.pipeline = new InboundPipeline(pipelineOptions);

    const context: Omit<ProtocolContext, "signal"> = {
      sendRaw: (data) => this.sendRaw(data),
      acceptInbound: (draft) => this.acceptInbound(draft),
      markReady: () => this.markReady(),
      setHeartbeat: (intervalMs, beat) => this.setHeartbeat(intervalMs, beat),
      setReconnectBaseDelay: (delayMs) => this.setReconnectBaseDelay(delayMs),
      requestReconnect: (reason) => this.requestReconnect(reason),
    };
    Object.defineProperty(context, "signal", {
      enumerable: true,
      get: () => this.abortController.signal,
    });
    this.protocolContext = context as ProtocolContext;
  }

  getStatus(): BotConnectorStatus {
    return {
      platform: this.platform,
      state: this.state,
      lastConnectedAt: this.lastConnectedAt,
      lastError: this.lastError,
    };
  }

  getMetrics(): Readonly<BotConnectionMetrics> {
    return { ...this.pipeline.getMetrics(), ...this.metrics };
  }

  getIngressSize(): number {
    return this.pipeline.getIngressSize();
  }

  /** Removes and returns queued messages; useful when autoDispatchIngress is false. */
  drainIngress(): InboundBotMessage[] {
    return this.pipeline.drainIngress();
  }

  connect(): Promise<void> {
    if (!this.stopped) {
      return this.connectPromise ?? Promise.resolve();
    }

    this.stopped = false;
    this.state = "connecting";
    this.lastError = null;
    this.failureCount = 0;
    this.messageChain = Promise.resolve();
    this.abortController = new AbortController();
    this.runId += 1;
    const runId = this.runId;

    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
    });
    void this.attemptConnect(runId);
    return this.connectPromise;
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    this.runId += 1;
    this.state = "disconnected";
    this.lastError = null;
    this.clearTimers();

    const session = this.session;
    this.session = null;
    session?.dispose?.();

    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close(1000, "client disconnect");
      } catch {
        // A socket that is already closing is fine.
      }
    }

    this.abortController.abort();
    this.rejectPendingConnect(new Error("bot connector disconnected"));
    this.logger.info("bot connector disconnected", { platform: this.platform });
  }

  async send(message: OutboundBotMessage): Promise<void> {
    if (message.platform !== this.platform) {
      throw new Error(
        `message platform ${message.platform} does not match connector platform ${this.platform}`,
      );
    }
    if (!this.protocol.sendMessage) {
      throw new Error(`${this.platform} adapter does not support outbound messages`);
    }
    await this.protocol.sendMessage(message, {
      sendRaw: (data) => this.sendRaw(data),
      ready: this.state === "connected",
    });
  }

  onMessage(listener: (message: InboundBotMessage) => void): () => void {
    return this.pipeline.onMessage(listener);
  }

  private async attemptConnect(runId: number): Promise<void> {
    if (!this.isActiveRun(runId)) {
      return;
    }

    this.metrics.connectAttempts += 1;
    if (this.state === "degraded") {
      // Preserve the visible degraded state until the dial actually starts.
      this.state = "connecting";
    }

    try {
      const resolved = await this.protocol.resolveConnection(this.abortController.signal);
      if (!this.isActiveRun(runId)) {
        return;
      }

      const options: WsConnectOptions = {
        signal: this.abortController.signal,
      };
      if (resolved.headers) {
        options.headers = resolved.headers;
      }
      const socket = await this.wsConnector.connect(resolved.url, options);
      if (!this.isActiveRun(runId)) {
        try {
          socket.close(1000, "stale connection");
        } catch {
          // Ignore cleanup failures on a stale socket.
        }
        return;
      }

      this.socket = socket;
      this.messageChain = Promise.resolve();
      this.session = this.protocol.createSession(this.protocolContext, resolved);

      socket.onMessage((data) => {
        if (this.socket !== socket || !this.isActiveRun(runId)) {
          return;
        }
        this.touchActivity();
        this.messageChain = this.messageChain
          .then(async () => {
            if (this.socket !== socket || !this.isActiveRun(runId)) {
              return;
            }
            await this.session?.onMessage(data);
          })
          .catch((error: unknown) => {
            this.handleSocketFailure(error, socket, false);
          });
      });

      socket.onClose((info) => {
        if (this.socket !== socket || !this.isActiveRun(runId)) {
          return;
        }
        this.session?.onClose?.(info);
        const terminal = this.protocol.isTerminalClose?.(info.code) ?? false;
        const reconnectDelayMs = this.protocol.getCloseReconnectDelayMs?.(info.code);
        this.handleSocketFailure(
          new Error(`websocket closed (code ${info.code}${info.reason ? `: ${info.reason}` : ""})`),
          socket,
          terminal,
          reconnectDelayMs,
        );
      });

      socket.onError((error) => {
        this.handleSocketFailure(error, socket, false);
      });

      await this.session.onOpen();
    } catch (error) {
      if (!this.isActiveRun(runId)) {
        return;
      }
      this.handleAttemptFailure(error, this.runId);
    }
  }

  private markReady(): void {
    if (this.stopped) {
      return;
    }
    const firstReady = this.state !== "connected";
    this.state = "connected";
    this.failureCount = 0;
    this.lastError = null;
    this.lastConnectedAt = this.now().toISOString();
    this.startHeartbeat();
    if (firstReady) {
      this.logger.info("bot connector connected", { platform: this.platform });
    }
    if (this.connectResolve) {
      const resolve = this.connectResolve;
      this.connectResolve = null;
      this.connectReject = null;
      this.connectPromise = null;
      resolve();
    }
  }

  private async acceptInbound(draft: InboundEventDraft): Promise<AcceptInboundResult> {
    return this.pipeline.accept(draft);
  }

  private setHeartbeat(intervalMs: number, beat: () => void): void {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new Error("heartbeat interval must be positive");
    }
    this.heartbeatIntervalMs = intervalMs;
    this.heartbeatBeat = beat;
    if (this.state === "connected") {
      this.startHeartbeat();
    }
  }

  private setReconnectBaseDelay(delayMs: number): void {
    if (Number.isFinite(delayMs) && delayMs >= 0) {
      this.reconnectBaseDelayMs = delayMs;
    }
  }

  private startHeartbeat(): void {
    this.clearHeartbeatTimers();
    if (this.heartbeatIntervalMs === null || this.heartbeatBeat === null) {
      return;
    }
    this.heartbeatTimer = setInterval(() => {
      if (this.state !== "connected" || this.heartbeatBeat === null) {
        return;
      }
      try {
        this.heartbeatBeat();
      } catch (error) {
        const socket = this.socket;
        if (socket) {
          this.handleSocketFailure(error, socket, false);
        }
      }
    }, this.heartbeatIntervalMs);
    // The watchdog is reset by inbound traffic, not by outbound heartbeats.
    this.armHeartbeatTimeout();
  }

  private armHeartbeatTimeout(): void {
    this.clearHeartbeatTimeout();
    if (this.heartbeatIntervalMs === null) {
      return;
    }
    const timeoutMs =
      this.heartbeatTimeoutOverrideMs ?? Math.max(this.heartbeatIntervalMs * 2 + 5_000, 10_000);
    this.heartbeatTimeoutTimer = setTimeout(() => {
      const socket = this.socket;
      if (socket && this.state === "connected") {
        this.handleSocketFailure(new Error("heartbeat timeout"), socket, false);
      }
    }, timeoutMs);
  }

  private touchActivity(): void {
    if (this.heartbeatIntervalMs !== null) {
      this.armHeartbeatTimeout();
    }
  }

  private clearHeartbeatTimeout(): void {
    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = null;
    }
  }

  private clearHeartbeatTimers(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.clearHeartbeatTimeout();
  }

  private clearTimers(): void {
    this.clearHeartbeatTimers();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private sendRaw(data: WsData): void {
    // Handshake traffic (QQ Identify/Resume) is sent after the socket opens but
    // before markReady(); only the physical socket is required here.
    if (!this.socket) {
      throw new Error("bot connector is not connected");
    }
    this.socket.send(data);
  }

  private requestReconnect(reason: string): void {
    if (this.stopped) {
      return;
    }
    const error = new Error(reason);
    const socket = this.socket;
    if (socket) {
      this.handleSocketFailure(error, socket, false);
      return;
    }
    if (this.state !== "degraded") {
      this.handleAttemptFailure(error, this.runId);
    }
  }

  private handleSocketFailure(
    error: unknown,
    socket: WsSocket,
    terminal: boolean,
    reconnectDelayMs?: number,
  ): void {
    if (this.socket !== socket) {
      return;
    }
    this.socket = null;
    const session = this.session;
    this.session = null;
    session?.dispose?.();
    try {
      socket.close(1000, "reconnecting");
    } catch {
      // The underlying socket may already be closed.
    }
    this.handleAttemptFailure(error, this.runId, terminal, reconnectDelayMs);
  }

  private handleAttemptFailure(
    error: unknown,
    runId: number,
    terminalOverride = false,
    reconnectDelayMs?: number,
  ): void {
    if (!this.isActiveRun(runId)) {
      return;
    }
    this.clearHeartbeatTimers();

    // An error thrown from onOpen (for example a failed Identify send) leaves
    // the physical socket open. Always drop it before scheduling a retry.
    const staleSocket = this.socket;
    this.socket = null;
    if (staleSocket) {
      try {
        staleSocket.close(1000, "reconnecting");
      } catch {
        // The underlying socket may already be closed.
      }
    }

    this.session?.dispose?.();
    this.session = null;

    this.lastError = safeErrorMessage(error);
    const terminal = terminalOverride || isTerminalBotError(error);
    if (terminal) {
      this.stopWithError(error);
      return;
    }

    this.failureCount += 1;
    if (this.failureCount >= this.reconnectPolicy.maxAttempts) {
      this.stopWithError(new Error(`reconnect attempts exhausted: ${this.lastError}`));
      return;
    }

    this.state = "degraded";
    const exponential = computeBackoffDelay(this.failureCount, this.reconnectPolicy, this.random);
    const delay = Math.max(
      exponential,
      this.reconnectBaseDelayMs,
      reconnectDelayMs !== undefined && reconnectDelayMs >= 0 ? reconnectDelayMs : 0,
    );
    this.metrics.reconnectsScheduled += 1;
    this.logger.warn("bot connector reconnecting", {
      platform: this.platform,
      attempt: this.failureCount,
      delayMs: delay,
      error: this.lastError,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.isActiveRun(runId)) {
        return;
      }
      this.state = "connecting";
      void this.attemptConnect(runId);
    }, delay);
  }

  private stopWithError(error: unknown): void {
    this.stopped = true;
    this.runId += 1;
    this.state = "disconnected";
    this.clearTimers();
    this.abortController.abort();

    const session = this.session;
    this.session = null;
    session?.dispose?.();

    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close(1000, "terminal error");
      } catch {
        // Ignore close failures on a dead socket.
      }
    }

    this.lastError = safeErrorMessage(error);
    this.metrics.terminalErrors += 1;
    this.logger.error("bot connector stopped", {
      platform: this.platform,
      error: this.lastError,
    });
    this.rejectPendingConnect(
      error instanceof Error ? error : new Error(this.lastError ?? "unknown error"),
    );
  }

  private rejectPendingConnect(error: Error): void {
    const reject = this.connectReject;
    this.connectResolve = null;
    this.connectReject = null;
    this.connectPromise = null;
    if (reject) {
      reject(error);
    }
  }

  private isActiveRun(runId: number): boolean {
    return !this.stopped && runId === this.runId;
  }
}
