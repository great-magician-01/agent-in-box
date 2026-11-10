import type { ApiErrorCode } from "@agent-in-box/protocol";

export class PersistenceError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class NotFoundError extends PersistenceError {
  constructor(message: string) {
    super("not_found", message);
  }
}

export class IdempotencyConflictError extends PersistenceError {
  constructor(key: string) {
    super("idempotency_conflict", `Idempotency key was reused with a different request: ${key}`);
  }
}

export class LeaseConflictError extends PersistenceError {
  constructor(vmId: string) {
    super("lease_conflict", `VM ${vmId} already has an active execution lease`);
  }
}

export class InvalidTransitionError extends PersistenceError {
  constructor(message: string) {
    super("conflict", message);
  }
}
