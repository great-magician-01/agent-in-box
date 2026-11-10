import { describe, expect, it } from "vitest";
import type { ProjectVmBindingRecord } from "@agent-in-box/protocol";
import {
  assertTaskTransition,
  canTransitionTask,
  canTransitionWorker,
  isLeaseActive,
  normalizeQueuePriority,
  validateBindings,
} from "./index";

function binding(vmId: string, isPrimary: boolean): ProjectVmBindingRecord {
  return {
    id: `binding-${vmId}`,
    projectId: "project-1",
    vmId,
    guestWorkspacePath: `/workspace/${vmId}`,
    isPrimary,
    createdAt: "2026-11-10T00:00:00.000Z",
  };
}

describe("task state machine", () => {
  it("allows valid transitions", () => {
    expect(canTransitionTask("queued", "running")).toBe(true);
    expect(canTransitionTask("running", "waiting_approval")).toBe(true);
    expect(canTransitionTask("waiting_approval", "running")).toBe(true);
    expect(canTransitionTask("failed", "queued")).toBe(true);
  });

  it("rejects terminal and skipping transitions", () => {
    expect(canTransitionTask("completed", "running")).toBe(false);
    expect(canTransitionTask("created", "completed")).toBe(false);
    expect(() => assertTaskTransition("cancelled", "running")).toThrow("Illegal task transition");
  });
});

describe("worker state machine", () => {
  it("does not archive a running worker directly", () => {
    expect(canTransitionWorker("running", "archived")).toBe(false);
    expect(canTransitionWorker("idle", "archiving")).toBe(true);
    expect(canTransitionWorker("archiving", "archived")).toBe(true);
    expect(canTransitionWorker("archived", "restoring")).toBe(true);
  });
});

describe("project VM bindings", () => {
  it("accepts many projects sharing one VM across individual binding lists", () => {
    expect(validateBindings([binding("linux-vm", true)])).toEqual([]);
  });

  it("requires exactly one primary binding", () => {
    expect(validateBindings([binding("linux-vm", false)])).toHaveLength(1);
    expect(validateBindings([binding("linux-vm", true), binding("windows-vm", true)])).toHaveLength(
      1,
    );
  });

  it("rejects duplicate VM bindings", () => {
    const errors = validateBindings([binding("linux-vm", true), binding("linux-vm", false)]);
    expect(errors.some((error) => error.includes("Duplicate binding"))).toBe(true);
  });
});

describe("lease and priority helpers", () => {
  it("detects expired leases", () => {
    const lease = {
      id: "lease-1",
      vmId: "linux-vm",
      owner: "worker" as const,
      taskId: "task-1",
      acquiredAt: "2026-11-10T00:00:00.000Z",
      expiresAt: "2026-11-10T00:00:30.000Z",
    };

    expect(isLeaseActive(lease, new Date("2026-11-10T00:00:10.000Z"))).toBe(true);
    expect(isLeaseActive(lease, new Date("2026-11-10T00:00:31.000Z"))).toBe(false);
  });

  it("clamps and normalizes priority", () => {
    expect(normalizeQueuePriority(500)).toBe(100);
    expect(normalizeQueuePriority(-500)).toBe(-100);
    expect(normalizeQueuePriority(Number.NaN)).toBe(0);
    expect(normalizeQueuePriority(4.9)).toBe(4);
  });
});
