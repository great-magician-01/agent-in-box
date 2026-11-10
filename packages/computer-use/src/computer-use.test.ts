import { describe, expect, it } from "vitest";
import { validateComputerAction } from "./index";

describe("validateComputerAction", () => {
  it("accepts basic actions", () => {
    expect(validateComputerAction({ type: "screenshot" }).ok).toBe(true);
    expect(validateComputerAction({ type: "click", point: { x: 10, y: 20 } }).ok).toBe(true);
    expect(validateComputerAction({ type: "type_text", text: "你好" }).ok).toBe(true);
    expect(validateComputerAction({ type: "keypress", keys: ["CTRL", "S"] }).ok).toBe(true);
    expect(validateComputerAction({ type: "wait", milliseconds: 500 }).ok).toBe(true);
  });

  it("rejects negative coordinates", () => {
    const result = validateComputerAction({ type: "click", point: { x: -1, y: 10 } });
    expect(result.ok).toBe(false);
  });

  it("rejects empty text and excessive waits", () => {
    expect(validateComputerAction({ type: "type_text", text: "" }).ok).toBe(false);
    expect(validateComputerAction({ type: "wait", milliseconds: 60_000 }).ok).toBe(false);
  });

  it("rejects unknown actions and malformed input", () => {
    expect(validateComputerAction({ type: "open_firewall" }).ok).toBe(false);
    expect(validateComputerAction("click").ok).toBe(false);
    expect(validateComputerAction(null).ok).toBe(false);
  });
});
