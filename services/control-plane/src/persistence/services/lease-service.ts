import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { Kysely } from "kysely";
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

@Injectable()
export class LeaseService {
  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DatabaseSchema>,
    private readonly leases: LeaseRepository,
  ) {}

  async acquire(input: AcquireLeaseInput): Promise<VmLeaseRecord> {
    const now = input.now ?? new Date();
    const ttlMs = input.ttlMs ?? DEFAULT_LEASE_TTL_MS;
    if (!Number.isFinite(ttlMs) || ttlMs < MIN_LEASE_TTL_MS || ttlMs > MAX_LEASE_TTL_MS) {
      throw new PersistenceError(
        "validation_failed",
        `Lease TTL must be between ${MIN_LEASE_TTL_MS} and ${MAX_LEASE_TTL_MS} ms`,
      );
    }

    return this.db.transaction().execute(async (trx) => {
      const existing = await this.leases.getByVm(input.vmId, trx);
      if (existing) {
        if (isLeaseActive(existing, now)) {
          if (existing.owner === input.owner && existing.taskId === input.taskId) {
            return existing;
          }
          throw new LeaseConflictError(input.vmId);
        }
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
      return lease;
    });
  }

  async release(vmId: string, leaseId: string): Promise<boolean> {
    const lease = await this.leases.getById(leaseId);
    if (!lease || lease.vmId !== vmId) {
      return false;
    }
    return this.leases.deleteById(leaseId);
  }

  async renew(
    leaseId: string,
    ttlMs = DEFAULT_LEASE_TTL_MS,
    now = new Date(),
  ): Promise<VmLeaseRecord> {
    if (!Number.isFinite(ttlMs) || ttlMs < MIN_LEASE_TTL_MS || ttlMs > MAX_LEASE_TTL_MS) {
      throw new PersistenceError(
        "validation_failed",
        `Lease TTL must be between ${MIN_LEASE_TTL_MS} and ${MAX_LEASE_TTL_MS} ms`,
      );
    }

    const lease = await this.leases.getById(leaseId);
    if (!lease) {
      throw new NotFoundError(`Lease not found: ${leaseId}`);
    }

    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    await this.leases.updateExpiry(leaseId, expiresAt);
    return { ...lease, expiresAt };
  }

  async getActive(vmId: string, now = new Date()): Promise<VmLeaseRecord | undefined> {
    const lease = await this.leases.getByVm(vmId);
    return lease && isLeaseActive(lease, now) ? lease : undefined;
  }
}
