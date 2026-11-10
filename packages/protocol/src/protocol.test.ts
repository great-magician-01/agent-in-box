import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  PROTOCOL_VERSION,
  isTaskStatus,
  isVmPowerState,
  isWorkerStatus,
  normalizePageRequest,
} from "./index";

describe("protocol", () => {
  it("pins the scaffold protocol version", () => {
    expect(PROTOCOL_VERSION).toBe("0.1.0");
  });

  it("validates task, worker and VM states", () => {
    expect(isTaskStatus("running")).toBe(true);
    expect(isTaskStatus("waiting_resources")).toBe(true);
    expect(isTaskStatus("done")).toBe(false);
    expect(isTaskStatus(null)).toBe(false);

    expect(isWorkerStatus("archived")).toBe(true);
    expect(isWorkerStatus("sleeping")).toBe(false);

    expect(isVmPowerState("suspended")).toBe(true);
    expect(isVmPowerState("paused")).toBe(false);
  });

  it("normalizes pagination limits and cursors", () => {
    expect(normalizePageRequest()).toEqual({ cursor: null, limit: DEFAULT_PAGE_SIZE });
    expect(normalizePageRequest({ limit: 10, cursor: " next " })).toEqual({
      cursor: "next",
      limit: 10,
    });
    expect(normalizePageRequest({ limit: 0 }).limit).toBe(1);
    expect(normalizePageRequest({ limit: MAX_PAGE_SIZE + 1 }).limit).toBe(MAX_PAGE_SIZE);
    expect(normalizePageRequest({ limit: Number.NaN }).limit).toBe(DEFAULT_PAGE_SIZE);
  });
});
