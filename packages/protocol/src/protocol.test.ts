import { describe, expect, it } from "vitest";
import { isTaskStatus, PROTOCOL_VERSION } from "./index";

describe("protocol", () => {
  it("pins the scaffold protocol version", () => {
    expect(PROTOCOL_VERSION).toBe("0.1.0");
  });

  it("validates task statuses", () => {
    expect(isTaskStatus("running")).toBe(true);
    expect(isTaskStatus("waiting_resources")).toBe(true);
    expect(isTaskStatus("done")).toBe(false);
    expect(isTaskStatus(null)).toBe(false);
  });
});
