/**
 * Shared local admission pipeline used by every bot transport.
 *
 * Ordering is intentional and must not be weakened:
 *   1. atomically persist the dedupe key (caller-provided store)
 *   2. append the message to the local ingress queue
 *   3. only then let the transport ACK the platform
 *
 * AI work never runs in the transport callback. Listeners are invoked from a
 * separate asynchronous dispatch loop.
 */

import { dedupKey, type BotPlatform, type InboundBotMessage } from "./contracts";
import { NOOP_BOT_LOGGER, safeErrorMessage, type BotConnectorLogger } from "./logger";

export interface InboundEventDraft {
  eventId: string;
  platformUserId: string;
  conversationId: string;
  text: string;
  receivedAt: string;
  raw: unknown;
}

export type AcceptInboundResult = "enqueued" | "duplicate";

/**
 * Implemented by the caller with durable storage (for example SQLite
 * `INSERT OR IGNORE`). `addIfAbsent` must be atomic and must persist before
 * resolving `true`, otherwise events can be replayed after an app restart.
 */
export interface DedupeStore {
  addIfAbsent(key: string): boolean | Promise<boolean>;
}

/**
 * A durable admission store receives the complete message together with its
 * dedupe key in one atomic call. Implementations must persist the message
 * before resolving `true`; the transport only ACKs after `accept` returns.
 * This closes the crash window between dedupe and the caller's own queue.
 */
export interface DurableIngressStore {
  admit(key: string, message: InboundBotMessage): boolean | Promise<boolean>;
}

export class InMemoryDedupeStore implements DedupeStore {
  private readonly keys = new Set<string>();

  addIfAbsent(key: string): boolean {
    if (this.keys.has(key)) {
      return false;
    }
    this.keys.add(key);
    return true;
  }

  has(key: string): boolean {
    return this.keys.has(key);
  }

  clear(): void {
    this.keys.clear();
  }
}

export class IngressQueue<T> {
  private items: T[] = [];
  private closed = false;

  constructor(private readonly capacity: number = 1_000) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("ingress capacity must be a positive integer");
    }
  }

  push(item: T): void {
    if (this.closed) {
      throw new Error("ingress queue is closed");
    }
    if (this.items.length >= this.capacity) {
      throw new Error("ingress queue is full");
    }
    this.items.push(item);
  }

  shift(): T | undefined {
    return this.items.shift();
  }

  drain(): T[] {
    const drained = this.items;
    this.items = [];
    return drained;
  }

  get size(): number {
    return this.items.length;
  }

  close(): void {
    this.closed = true;
    this.items = [];
  }
}

export interface IngressMetrics {
  received: number;
  enqueued: number;
  duplicates: number;
  delivered: number;
  deliveryErrors: number;
}

export interface InboundPipelineOptions {
  platform: BotPlatform;
  deviceId: string;
  dedupeStore?: DedupeStore;
  /** Takes precedence over `dedupeStore` and persists the full message atomically. */
  ingressStore?: DurableIngressStore;
  ingressCapacity?: number;
  /**
   * When false, listeners registered through `onMessage` are not dispatched
   * automatically; the caller must consume `drainIngress()` itself.
   */
  autoDispatchIngress?: boolean;
  logger?: BotConnectorLogger;
}

export class InboundPipeline {
  private readonly platform: BotPlatform;
  private readonly deviceId: string;
  private readonly dedupeStore: DedupeStore;
  private readonly ingressStore: DurableIngressStore | null;
  private readonly logger: BotConnectorLogger;
  private readonly autoDispatchIngress: boolean;
  private readonly ingress: IngressQueue<InboundBotMessage>;
  private readonly listeners = new Set<(message: InboundBotMessage) => void>();
  private readonly metrics: IngressMetrics = {
    received: 0,
    enqueued: 0,
    duplicates: 0,
    delivered: 0,
    deliveryErrors: 0,
  };
  private dispatchScheduled = false;

  constructor(options: InboundPipelineOptions) {
    if (!options.deviceId) {
      throw new Error("deviceId is required");
    }
    this.platform = options.platform;
    this.deviceId = options.deviceId;
    this.dedupeStore = options.dedupeStore ?? new InMemoryDedupeStore();
    this.ingressStore = options.ingressStore ?? null;
    this.logger = options.logger ?? NOOP_BOT_LOGGER;
    this.autoDispatchIngress = options.autoDispatchIngress ?? true;
    this.ingress = new IngressQueue<InboundBotMessage>(options.ingressCapacity);
  }

  async accept(draft: InboundEventDraft): Promise<AcceptInboundResult> {
    this.metrics.received += 1;
    const key = dedupKey(this.platform, this.deviceId, draft.eventId);
    const message: InboundBotMessage = {
      platform: this.platform,
      eventId: draft.eventId,
      platformUserId: draft.platformUserId,
      conversationId: draft.conversationId,
      text: draft.text,
      receivedAt: draft.receivedAt,
      raw: draft.raw,
    };
    const isNew = this.ingressStore
      ? await this.ingressStore.admit(key, message)
      : await this.dedupeStore.addIfAbsent(key);
    if (!isNew) {
      this.metrics.duplicates += 1;
      this.logger.debug("duplicate bot event ignored", {
        platform: this.platform,
        eventId: draft.eventId,
      });
      return "duplicate";
    }

    this.ingress.push(message);
    this.metrics.enqueued += 1;
    this.scheduleDispatch();
    return "enqueued";
  }

  onMessage(listener: (message: InboundBotMessage) => void): () => void {
    this.listeners.add(listener);
    this.scheduleDispatch();
    return () => {
      this.listeners.delete(listener);
    };
  }

  getIngressSize(): number {
    return this.ingress.size;
  }

  /** Removes and returns queued messages; useful when autoDispatchIngress is false. */
  drainIngress(): InboundBotMessage[] {
    return this.ingress.drain();
  }

  getMetrics(): Readonly<IngressMetrics> {
    return { ...this.metrics };
  }

  private scheduleDispatch(): void {
    if (!this.autoDispatchIngress || this.dispatchScheduled || this.listeners.size === 0) {
      return;
    }
    this.dispatchScheduled = true;
    setImmediate(() => {
      void this.runDispatchLoop();
    });
  }

  private async runDispatchLoop(): Promise<void> {
    try {
      while (this.listeners.size > 0) {
        const message = this.ingress.shift();
        if (!message) {
          return;
        }
        for (const listener of this.listeners) {
          try {
            await listener(message);
            this.metrics.delivered += 1;
          } catch (error) {
            this.metrics.deliveryErrors += 1;
            this.logger.error("bot message listener failed", {
              platform: this.platform,
              eventId: message.eventId,
              error: safeErrorMessage(error),
            });
          }
        }
      }
    } finally {
      this.dispatchScheduled = false;
      if (this.ingress.size > 0 && this.listeners.size > 0) {
        this.scheduleDispatch();
      }
    }
  }
}
