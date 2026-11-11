import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Inject, Injectable, Optional, type OnModuleInit } from "@nestjs/common";
import type { Kysely, Selectable } from "kysely";
import { PersistenceError } from "../persistence/errors";
import type { CuaTokensTable, DatabaseSchema } from "../persistence/schema";
import { KYSELY } from "../persistence/tokens";

export const CUA_TOKEN_OPTIONS = Symbol("AGENT_IN_BOX_CUA_TOKEN_OPTIONS");

export interface CuaTokenOptions {
  ttlMs?: number;
  now?: () => Date;
}

export interface CuaTokenContext {
  id: string;
  workerId: string;
  vmId: string;
  sessionId: string;
  taskId: string | null;
  expiresAt: string;
}

@Injectable()
export class CuaTokenService implements OnModuleInit {
  private readonly ttlMs: number;
  private readonly now: () => Date;

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DatabaseSchema>,
    @Optional() @Inject(CUA_TOKEN_OPTIONS) options: CuaTokenOptions = {},
  ) {
    this.ttlMs = Math.max(30_000, options.ttlMs ?? 15 * 60_000);
    this.now = options.now ?? (() => new Date());
  }

  async onModuleInit(): Promise<void> {
    // Raw tokens live only in Guest processes. A restart cannot prove the old
    // Pi process is ours, so every previously issued token is revoked.
    await this.revokeAll("control_plane_restart");
  }

  async issue(input: {
    workerId: string;
    vmId: string;
    sessionId: string;
    taskId?: string | null;
  }): Promise<{ token: string; context: CuaTokenContext }> {
    const token = randomBytes(32).toString("base64url");
    const id = randomUUID();
    const now = this.now();
    const expiresAt = new Date(now.getTime() + this.ttlMs).toISOString();
    await this.db
      .insertInto("cua_tokens")
      .values({
        id,
        token_hash: hash(token),
        worker_id: input.workerId,
        vm_id: input.vmId,
        session_id: input.sessionId,
        task_id: input.taskId ?? null,
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
        id,
        workerId: input.workerId,
        vmId: input.vmId,
        sessionId: input.sessionId,
        taskId: input.taskId ?? null,
        expiresAt,
      },
    };
  }

  async authenticate(token: string): Promise<CuaTokenContext> {
    if (!token || token.length > 256) throw unauthorized();
    const row = await this.db
      .selectFrom("cua_tokens")
      .selectAll()
      .where("token_hash", "=", hash(token))
      .executeTakeFirst();
    if (!row || row.revoked_at || new Date(row.expires_at).getTime() <= this.now().getTime()) {
      throw unauthorized();
    }
    const now = this.now().toISOString();
    await this.db
      .updateTable("cua_tokens")
      .set({ last_used_at: now })
      .where("id", "=", row.id)
      .execute();
    return context(row);
  }

  async renew(id: string): Promise<CuaTokenContext> {
    const row = await this.db
      .selectFrom("cua_tokens")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row || row.revoked_at) throw unauthorized();
    const expiresAt = new Date(this.now().getTime() + this.ttlMs).toISOString();
    await this.db
      .updateTable("cua_tokens")
      .set({ expires_at: expiresAt })
      .where("id", "=", id)
      .execute();
    return context({ ...row, expires_at: expiresAt });
  }

  async bindTask(id: string, taskId: string | null): Promise<void> {
    await this.db
      .updateTable("cua_tokens")
      .set({ task_id: taskId })
      .where("id", "=", id)
      .where("revoked_at", "is", null)
      .execute();
  }

  async bindSession(id: string, sessionId: string): Promise<void> {
    await this.db
      .updateTable("cua_tokens")
      .set({ session_id: sessionId })
      .where("id", "=", id)
      .where("revoked_at", "is", null)
      .execute();
  }

  async revoke(id: string, reason: string): Promise<boolean> {
    const result = await this.db
      .updateTable("cua_tokens")
      .set({ revoked_at: this.now().toISOString(), revoke_reason: reason.slice(0, 200) })
      .where("id", "=", id)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows ?? 0) > 0;
  }

  async revokeWorker(workerId: string, reason: string): Promise<number> {
    const rows = await this.db
      .selectFrom("cua_tokens")
      .select("id")
      .where("worker_id", "=", workerId)
      .where("revoked_at", "is", null)
      .execute();
    for (const row of rows) await this.revoke(row.id, reason);
    return rows.length;
  }

  async revokeAll(reason: string): Promise<number> {
    const rows = await this.db
      .selectFrom("cua_tokens")
      .select("id")
      .where("revoked_at", "is", null)
      .execute();
    for (const row of rows) await this.revoke(row.id, reason);
    return rows.length;
  }
}

function context(row: Selectable<CuaTokensTable>): CuaTokenContext {
  return {
    id: row.id,
    workerId: row.worker_id,
    vmId: row.vm_id,
    sessionId: row.session_id,
    taskId: row.task_id,
    expiresAt: row.expires_at,
  };
}

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function unauthorized(): PersistenceError {
  return new PersistenceError("unauthorized", "Computer Use 令牌无效、过期或已撤销");
}
