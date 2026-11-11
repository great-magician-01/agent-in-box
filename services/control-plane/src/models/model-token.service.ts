import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Inject, Injectable, Optional, type OnModuleInit } from "@nestjs/common";
import type { Kysely } from "kysely";
import { PersistenceError } from "../persistence/errors";
import type {
  DatabaseSchema,
  ModelTokensTable,
  RouterModelTokensTable,
} from "../persistence/schema";
import { KYSELY } from "../persistence/tokens";
import type { Selectable } from "kysely";

export const MODEL_TOKEN_OPTIONS = Symbol("AGENT_IN_BOX_MODEL_TOKEN_OPTIONS");

export interface ModelTokenOptions {
  ttlMs?: number;
  routerTtlMs?: number;
  now?: () => Date;
}

export interface ModelTokenContext {
  kind: "worker";
  id: string;
  workerId: string;
  taskId: string | null;
  vmId: string;
  providerId: string;
  model: string;
  sessionId: string;
  expiresAt: string;
}

/**
 * Host-local Router access to the Model Broker. The Router is not a VM Worker, so
 * this token has no VM/task binding; it is still short-lived and revocable.
 */
export interface RouterTokenContext {
  kind: "router";
  id: string;
  conversationId: string;
  providerId: string;
  model: string;
  expiresAt: string;
  workerId: "host-router";
  vmId: "host";
  taskId: null;
  sessionId: string;
}

export type BrokerTokenContext = ModelTokenContext | RouterTokenContext;

export const ROUTER_TOKEN_WORKER_ID = "host-router";
export const ROUTER_TOKEN_VM_ID = "host";

@Injectable()
export class ModelTokenService implements OnModuleInit {
  private readonly ttlMs: number;
  private readonly routerTtlMs: number;
  private readonly now: () => Date;
  private readonly revocationListeners = new Map<string, Set<(reason: string) => void>>();

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DatabaseSchema>,
    @Optional() @Inject(MODEL_TOKEN_OPTIONS) options: ModelTokenOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
    this.routerTtlMs = options.routerTtlMs ?? 8 * 60 * 60_000;
    this.now = options.now ?? (() => new Date());
  }

  async onModuleInit(): Promise<void> {
    // Raw tokens live only in Guest/Router processes. A control-plane restart
    // therefore revokes them instead of trusting untracked old processes.
    await Promise.all([
      this.revokeAll("control_plane_restart"),
      this.revokeAllRouter("control_plane_restart"),
    ]);
  }

  async issue(input: {
    workerId: string;
    vmId: string;
    sessionId: string;
    providerId: string;
    model: string;
    taskId?: string | null;
  }): Promise<{ token: string; context: ModelTokenContext }> {
    const token = randomBytes(32).toString("base64url");
    const id = randomUUID();
    const now = this.now();
    const expiresAt = new Date(now.getTime() + this.ttlMs).toISOString();
    await this.db
      .insertInto("model_tokens")
      .values({
        id,
        token_hash: hash(token),
        worker_id: input.workerId,
        task_id: input.taskId ?? null,
        vm_id: input.vmId,
        provider_id: input.providerId,
        model: input.model,
        session_id: input.sessionId,
        expires_at: expiresAt,
        revoked_at: null,
        revoke_reason: null,
        created_at: now.toISOString(),
        last_used_at: null,
      })
      .execute();
    return {
      token,
      context: {
        kind: "worker",
        id,
        workerId: input.workerId,
        taskId: input.taskId ?? null,
        vmId: input.vmId,
        providerId: input.providerId,
        model: input.model,
        sessionId: input.sessionId,
        expiresAt,
      },
    };
  }

  async authenticate(token: string): Promise<ModelTokenContext> {
    if (!token || token.length > 256) throw unauthorized();
    const row = await this.db
      .selectFrom("model_tokens")
      .selectAll()
      .where("token_hash", "=", hash(token))
      .executeTakeFirst();
    if (!row || row.revoked_at || new Date(row.expires_at).getTime() <= this.now().getTime()) {
      throw unauthorized();
    }
    const now = this.now().toISOString();
    await this.db
      .updateTable("model_tokens")
      .set({ last_used_at: now })
      .where("id", "=", row.id)
      .execute();
    return context(row);
  }

  async renew(id: string): Promise<ModelTokenContext> {
    const row = await this.db
      .selectFrom("model_tokens")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row || row.revoked_at) throw unauthorized();
    const expiresAt = new Date(this.now().getTime() + this.ttlMs).toISOString();
    await this.db
      .updateTable("model_tokens")
      .set({ expires_at: expiresAt })
      .where("id", "=", id)
      .execute();
    return context({ ...row, expires_at: expiresAt });
  }

  async bindTask(id: string, taskId: string | null): Promise<void> {
    await this.db
      .updateTable("model_tokens")
      .set({ task_id: taskId })
      .where("id", "=", id)
      .where("revoked_at", "is", null)
      .execute();
  }

  async bindSession(id: string, sessionId: string): Promise<void> {
    await this.db
      .updateTable("model_tokens")
      .set({ session_id: sessionId })
      .where("id", "=", id)
      .where("revoked_at", "is", null)
      .execute();
  }

  async revoke(id: string, reason: string): Promise<boolean> {
    const now = this.now().toISOString();
    const result = await this.db
      .updateTable("model_tokens")
      .set({ revoked_at: now, revoke_reason: reason.slice(0, 200) })
      .where("id", "=", id)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    const revoked = Number(result.numUpdatedRows ?? 0) > 0;
    if (revoked) this.notify(id, reason);
    return revoked;
  }

  async revokeWorker(workerId: string, reason: string): Promise<number> {
    const rows = await this.db
      .selectFrom("model_tokens")
      .select("id")
      .where("worker_id", "=", workerId)
      .where("revoked_at", "is", null)
      .execute();
    for (const row of rows) await this.revoke(row.id, reason);
    return rows.length;
  }

  async revokeAll(reason: string): Promise<number> {
    const rows = await this.db
      .selectFrom("model_tokens")
      .select("id")
      .where("revoked_at", "is", null)
      .execute();
    for (const row of rows) await this.revoke(row.id, reason);
    return rows.length;
  }

  async issueRouter(input: {
    conversationId: string;
    providerId: string;
    model: string;
  }): Promise<{ token: string; context: RouterTokenContext }> {
    const token = randomBytes(32).toString("base64url");
    const id = randomUUID();
    const now = this.now();
    const expiresAt = new Date(now.getTime() + this.routerTtlMs).toISOString();
    await this.db
      .insertInto("router_model_tokens")
      .values({
        id,
        token_hash: hash(token),
        conversation_id: input.conversationId,
        provider_id: input.providerId,
        model: input.model,
        expires_at: expiresAt,
        revoked_at: null,
        revoke_reason: null,
        created_at: now.toISOString(),
        last_used_at: null,
      })
      .execute();
    return {
      token,
      context: {
        kind: "router",
        id,
        conversationId: input.conversationId,
        providerId: input.providerId,
        model: input.model,
        expiresAt,
        workerId: ROUTER_TOKEN_WORKER_ID,
        vmId: ROUTER_TOKEN_VM_ID,
        taskId: null,
        sessionId: input.conversationId,
      },
    };
  }

  async authenticateRouter(token: string): Promise<RouterTokenContext> {
    if (!token || token.length > 256) throw unauthorized();
    const row = await this.db
      .selectFrom("router_model_tokens")
      .selectAll()
      .where("token_hash", "=", hash(token))
      .executeTakeFirst();
    if (!row || row.revoked_at || new Date(row.expires_at).getTime() <= this.now().getTime()) {
      throw unauthorized();
    }
    await this.db
      .updateTable("router_model_tokens")
      .set({ last_used_at: this.now().toISOString() })
      .where("id", "=", row.id)
      .execute();
    return routerContext(row);
  }

  /** The Broker accepts both VM Worker and host Router tokens. */
  async authenticateBroker(token: string): Promise<BrokerTokenContext> {
    if (!token || token.length > 256) throw unauthorized();
    const worker = await this.db
      .selectFrom("model_tokens")
      .selectAll()
      .where("token_hash", "=", hash(token))
      .executeTakeFirst();
    if (
      worker &&
      !worker.revoked_at &&
      new Date(worker.expires_at).getTime() > this.now().getTime()
    ) {
      await this.db
        .updateTable("model_tokens")
        .set({ last_used_at: this.now().toISOString() })
        .where("id", "=", worker.id)
        .execute();
      return context(worker);
    }
    return this.authenticateRouter(token);
  }

  async renewRouter(id: string): Promise<RouterTokenContext> {
    const row = await this.db
      .selectFrom("router_model_tokens")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row || row.revoked_at) throw unauthorized();
    const expiresAt = new Date(this.now().getTime() + this.routerTtlMs).toISOString();
    await this.db
      .updateTable("router_model_tokens")
      .set({ expires_at: expiresAt })
      .where("id", "=", id)
      .execute();
    return routerContext({ ...row, expires_at: expiresAt });
  }

  async revokeRouter(id: string, reason: string): Promise<boolean> {
    const result = await this.db
      .updateTable("router_model_tokens")
      .set({ revoked_at: this.now().toISOString(), revoke_reason: reason.slice(0, 200) })
      .where("id", "=", id)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    const revoked = Number(result.numUpdatedRows ?? 0) > 0;
    if (revoked) this.notify(id, reason);
    return revoked;
  }

  async revokeRouterConversation(conversationId: string, reason: string): Promise<number> {
    const rows = await this.db
      .selectFrom("router_model_tokens")
      .select("id")
      .where("conversation_id", "=", conversationId)
      .where("revoked_at", "is", null)
      .execute();
    for (const row of rows) await this.revokeRouter(row.id, reason);
    return rows.length;
  }

  async revokeAllRouter(reason: string): Promise<number> {
    const rows = await this.db
      .selectFrom("router_model_tokens")
      .select("id")
      .where("revoked_at", "is", null)
      .execute();
    for (const row of rows) await this.revokeRouter(row.id, reason);
    return rows.length;
  }

  async onRevoke(id: string, listener: (reason: string) => void): Promise<() => void> {
    const listeners = this.revocationListeners.get(id) ?? new Set<(reason: string) => void>();
    listeners.add(listener);
    this.revocationListeners.set(id, listeners);
    const row =
      (await this.db
        .selectFrom("model_tokens")
        .select(["revoked_at", "revoke_reason"])
        .where("id", "=", id)
        .executeTakeFirst()) ??
      (await this.db
        .selectFrom("router_model_tokens")
        .select(["revoked_at", "revoke_reason"])
        .where("id", "=", id)
        .executeTakeFirst());
    if (!row || row.revoked_at) {
      listeners.delete(listener);
      throw unauthorized();
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.revocationListeners.delete(id);
    };
  }

  private notify(id: string, reason: string): void {
    for (const listener of this.revocationListeners.get(id) ?? []) listener(reason);
    this.revocationListeners.delete(id);
  }
}

function context(row: Selectable<ModelTokensTable>): ModelTokenContext {
  return {
    kind: "worker",
    id: row.id,
    workerId: row.worker_id,
    taskId: row.task_id,
    vmId: row.vm_id,
    providerId: row.provider_id,
    model: row.model,
    sessionId: row.session_id,
    expiresAt: row.expires_at,
  };
}

function routerContext(row: Selectable<RouterModelTokensTable>): RouterTokenContext {
  return {
    kind: "router",
    id: row.id,
    conversationId: row.conversation_id,
    providerId: row.provider_id,
    model: row.model,
    expiresAt: row.expires_at,
    workerId: ROUTER_TOKEN_WORKER_ID,
    vmId: ROUTER_TOKEN_VM_ID,
    taskId: null,
    sessionId: row.conversation_id,
  };
}

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function unauthorized(): PersistenceError {
  return new PersistenceError("unauthorized", "Model Broker 令牌无效、过期或已撤销");
}
