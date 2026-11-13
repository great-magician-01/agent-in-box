import { describe, expect, it } from "vitest";
import type { ProjectVmBindingRecord } from "@agent-in-box/protocol";
import {
  assertTaskTransition,
  canTransitionTask,
  canTransitionWorker,
  guestPathEqualsOrWithin,
  guestPathsEqual,
  isLeaseActive,
  isSafeAbsoluteGuestPath,
  normalizeQueuePriority,
  normalizeGuestWorkspacePath,
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
    expect(canTransitionTask("running", "waiting_human")).toBe(true);
    expect(canTransitionTask("waiting_human", "queued")).toBe(true);
    expect(canTransitionTask("waiting_human", "waiting_vm")).toBe(true);
    expect(canTransitionTask("waiting_human", "running")).toBe(false);
    expect(canTransitionTask("failed", "queued")).toBe(true);
    expect(canTransitionTask("failed", "waiting_vm")).toBe(true);
    expect(canTransitionTask("failed", "created")).toBe(true);
    expect(canTransitionTask("queued", "waiting_vm")).toBe(true);
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

  it("validates guest workspace paths without treating them as host paths", () => {
    expect(normalizeGuestWorkspacePath("/home/worker/project/")).toBe("/home/worker/project");
    expect(normalizeGuestWorkspacePath("C:\\Users\\aib-worker\\workspace\\")).toBe(
      "C:\\Users\\aib-worker\\workspace",
    );
    expect(normalizeGuestWorkspacePath("d:/work/project")).toBe("D:\\work\\project");
    expect(() => normalizeGuestWorkspacePath("relative/path")).toThrow("absolute");
    expect(() => normalizeGuestWorkspacePath("/home/worker/../host")).toThrow("without '..'");
    expect(() => normalizeGuestWorkspacePath("C:\\Users\\..\\Windows")).toThrow("without '..'");
    expect(() => normalizeGuestWorkspacePath("C:\\")).toThrow("filesystem root");
    expect(() => normalizeGuestWorkspacePath("\\\\server\\share")).toThrow("absolute");
    expect(() => normalizeGuestWorkspacePath("C:relative")).toThrow("absolute");
    expect(() => normalizeGuestWorkspacePath("C:\\work:stream")).toThrow("absolute");
  });

  it("checks guest path containment across POSIX and Windows roots", () => {
    expect(isSafeAbsoluteGuestPath("/home/worker")).toBe(true);
    expect(isSafeAbsoluteGuestPath("C:\\Users\\aib-worker")).toBe(true);
    expect(isSafeAbsoluteGuestPath("//server/share")).toBe(false);
    expect(isSafeAbsoluteGuestPath("relative")).toBe(false);
    expect(guestPathEqualsOrWithin("/home/worker/report.txt", "/home/worker")).toBe(true);
    expect(guestPathEqualsOrWithin("/home/worker2/report.txt", "/home/worker")).toBe(false);
    expect(guestPathEqualsOrWithin("C:\\Users\\aib-worker\\out.txt", "c:\\users\\AIB-WORKER")).toBe(
      true,
    );
    expect(
      guestPathEqualsOrWithin("C:\\Users\\aib-worker2\\out.txt", "C:\\Users\\aib-worker"),
    ).toBe(false);
    expect(guestPathEqualsOrWithin("C:\\Users\\aib-worker\\out.txt", "/home")).toBe(false);
    expect(
      guestPathsEqual("C:\\Users\\AIB-Worker\\workspace\\", "c:/users/aib-worker/workspace"),
    ).toBe(true);
    expect(guestPathsEqual("/home/worker/workspace/", "/home/worker/workspace")).toBe(true);
    expect(guestPathsEqual("/home/worker/Workspace", "/home/worker/workspace")).toBe(false);
    expect(guestPathsEqual("/home/worker/./project", "/home/worker//project/")).toBe(true);
    expect(guestPathsEqual("C:\\Users\\aib\\.\\workspace", " c:/users/AIB//workspace ")).toBe(true);
    expect(guestPathsEqual("/home\\worker\\proof.txt", "/home/worker/proof.txt")).toBe(false);
    expect(guestPathEqualsOrWithin(" C:\\Users\\aib\\proof.txt ", " C:\\Users\\aib ")).toBe(true);
  });
});
