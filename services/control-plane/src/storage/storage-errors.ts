import type { ApiErrorCode } from "@agent-in-box/protocol";
import { PersistenceError } from "../persistence/errors";

export class StorageError extends PersistenceError {
  constructor(code: ApiErrorCode, message: string, details?: unknown) {
    super(code, message, details);
    this.name = "StorageError";
  }
}

export class StorageLockedError extends StorageError {
  constructor(message: string) {
    super("conflict", message);
    this.name = "StorageLockedError";
  }
}
