import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { Kysely } from "kysely";
import type { VmControlState, VmControlView } from "@agent-in-box/protocol";
import { isLeaseActive, type VmLeaseRecord } from "@agent-in-box/domain";
import { LeaseConflictError, NotFoundError, PersistenceError } from "../errors";
import { KYSELY } from "../tokens";
import type { DatabaseSchema } from "../schema";
import { LeaseRepository } from "../repositories/lease-repository";

const DEFAULT_LEASE_TTL_MS = 30_000;
const MIN_LEASE_TTL_MS = 1_000;
const MAX_LEASE_TTL_MS = 24 * 60 * 60 * 1_000;

export interface AcquireLeaseInput {
  vmId: string;
  owner: "worker" | "human";
  taskId: string | null;
  ttlMs?: number;
  now?: Date;
}

function controlState(lease: VmLeaseRecord | undefined): VmControlState {
  return lease ? (lease.owner === "worker" ? "ai" : "human") : "idle";
}

@Injectable()
export class LeaseService {
  private readonly inputLocks = new Map<string, Promise<void>>();

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DatabaseSchema>,
    private readonly leases: LeaseRepository,
  ) {}

  /**
   * Guest RPC and VNC input both use this lock. Acquisition takes the same lock,
   * so a takeover cannot slip between the final Lease check and an input write.
   */
  async executeWithLease<T>(
    vmId: string,
    leaseId: string,
    owner: "worker" | "human",
    operation: (lease: VmLeaseRecord) => Promise<T>,
  ): Promise<T> {
    return this.withVmLock(vmId, async () => {
      const lease = await this.requireActive(vmId, leaseId, owner);
      return operation(lease);
    });
  }

  async acquire(input: AcquireLeaseInput): Promise<VmLeaseRecord> {
    return this.withVmLock(input.vmId, async () => {
      const now = input.now ?? new Date();
      const ttlMs = validTtl(input.ttlMs ?? DEFAULT_LEASE_TTL_MS);

      return this.db.transaction().execute(async (trx) => {
        const existing = await this.leases.getByVm(input.vmId, trx);
        const existingActive = existing && isLeaseActive(existing, now) ? existing : undefined;
        if (existingActive) {
          const sameWorker =
            input.owner === "worker" &&
            existingActive.owner === "worker" &&
            existingActive.taskId === input.taskId;
          if (sameWorker) {
            return existingActive;
          }
          // Human takeover is deliberate preemption. Workers must never preempt
          // one another or a human; a new human session also revokes old consoles.
          if (input.owner !== "human") {
            throw new LeaseConflictError(input.vmId);
          }
        }
        if (existing) {
          await this.leases.deleteById(existing.id, trx);
        }

        const lease: VmLeaseRecord = {
          id: randomUUID(),
          vmId: input.vmId,
          owner: input.owner,
          taskId: input.taskId,
          acquiredAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
        };
        await this.leases.insert(lease, trx);
        await this.writeControlEvent(trx, controlState(existingActive), controlState(lease), lease);
        return lease;
      });
    });
  }

  async release(vmId: string, leaseId: string): Promise<boolean> {
    return this.withVmLock(vmId, async () => {
      const lease = await this.leases.getById(leaseId);
      if (!lease || lease.vmId !== vmId) {
        return false;
      }
      const released = await this.db.transaction().execute(async (trx) => {
        const deleted = await this.leases.deleteById(leaseId, trx);
        if (deleted) {
          await this.writeControlEvent(trx, controlState(lease), "idle", lease);
        }
        return deleted;
      });
      return released;
    });
  }

  async renew(leaseId: string, ttlMs = DEFAULT_LEASE_TTL_MS, now?: Date): Promise<VmLeaseRecord> {
    const existing = await this.leases.getById(leaseId);
    if (!existing) {
      throw new NotFoundError(`Lease not found: ${leaseId}`);
    }
    return this.renewForVm(existing.vmId, leaseId, ttlMs, now);
  }

  async renewForVm(
    vmId: string,
    leaseId: string,
    ttlMs = DEFAULT_LEASE_TTL_MS,
    now?: Date,
  ): Promise<VmLeaseRecord> {
    const validDuration = validTtl(ttlMs);
    // Renewal must not wait for the input lock: an input RPC may legitimately
    // run for the full 30-second lease TTL. The short database transaction
    // serializes renewal with acquire/release without blocking desktop input.
    return this.db.transaction().execute(async (trx) => {
      const effectiveNow = now ?? new Date();
      const lease = await this.leases.getById(leaseId, trx);
      if (!lease || lease.vmId !== vmId) {
        throw new NotFoundError(`Lease not found: ${leaseId}`);
      }
      if (!isLeaseActive(lease, effectiveNow)) {
        throw new LeaseConflictError(vmId);
      }
      const requestedExpiry = effectiveNow.getTime() + validDuration;
      const expiresAt =
        requestedExpiry > new Date(lease.expiresAt).getTime()
          ? new Date(requestedExpiry).toISOString()
          : lease.expiresAt;
      await this.leases.updateExpiry(leaseId, expiresAt, trx);
      return { ...lease, expiresAt };
    });
  }

  async getActive(vmId: string, now = new Date()): Promise<VmLeaseRecord | undefined> {
    const lease = await this.leases.getByVm(vmId);
    return lease && isLeaseActive(lease, now) ? lease : undefined;
  }

  async control(vmId: string): Promise<VmControlView> {
    const lease = await this.getActive(vmId);
    return { vmId, state: controlState(lease), lease: lease ?? null };
  }

  private async requireActive(
    vmId: string,
    leaseId: string,
    owner: "worker" | "human",
  ): Promise<VmLeaseRecord> {
    const lease = await this.leases.getByVm(vmId);
    if (
      !lease ||
      lease.id !== leaseId ||
      lease.owner !== owner ||
      !isLeaseActive(lease, new Date())
    ) {
      throw new LeaseConflictError(vmId);
    }
    return lease;
  }

  private async writeControlEvent(
    trx: Kysely<DatabaseSchema>,
    from: VmControlState,
    to: VmControlState,
    lease: VmLeaseRecord,
  ): Promise<void> {
    await trx
      .insertInto("outbox")
      .values({
        topic: "vm.control_changed",
        payload_json: JSON.stringify({
          vmId: lease.vmId,
          from,
          to,
          leaseId: to === "idle" ? null : lease.id,
        }),
        created_at: new Date().toISOString(),
        published_at: null,
        attempts: 0,
        last_error: null,
      })
      .execute();
  }

  private async withVmLock<T>(vmId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.inputLocks.get(vmId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.inputLocks.set(vmId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.inputLocks.get(vmId) === tail) {
        this.inputLocks.delete(vmId);
      }
    }
  }
}

function validTtl(ttlMs: number): number {
  if (!Number.isFinite(ttlMs) || ttlMs < MIN_LEASE_TTL_MS || ttlMs > MAX_LEASE_TTL_MS) {
    throw new PersistenceError(
      "validation_failed",
      `Lease TTL must be between ${MIN_LEASE_TTL_MS} and ${MAX_LEASE_TTL_MS} ms`,
    );
  }
  return ttlMs;
}
