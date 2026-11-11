import { describe, expect, it } from "vitest";
import {
  assertActionFitsDisplay,
  computerActionSignature,
  convertComputerActionCoordinates,
  validateComputerAction,
} from "./index";

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

  it("validates normalized coordinates and screenshot references", () => {
    expect(
      validateComputerAction({
        type: "click",
        point: { x: 0.5, y: 0.25 },
        coordinateSpace: "normalized",
        screenshotId: "shot-1",
        count: 2,
      }).ok,
    ).toBe(true);
    expect(
      validateComputerAction({
        type: "drag",
        from: { x: 0.1, y: 0.2 },
        to: { x: 1.2, y: 0.5 },
        coordinateSpace: "normalized",
      }).ok,
    ).toBe(false);
    expect(validateComputerAction({ type: "wait", milliseconds: 1, screenshotId: "../x" }).ok).toBe(
      false,
    );
  });
});

describe("convertComputerActionCoordinates", () => {
  it("converts normalized points to absolute desktop pixels", () => {
    const action = convertComputerActionCoordinates(
      {
        type: "drag",
        from: { x: 0, y: 0 },
        to: { x: 1, y: 0.5 },
        coordinateSpace: "normalized",
      },
      1920,
      1080,
    );
    expect(action).toMatchObject({
      type: "drag",
      from: { x: 0, y: 0 },
      to: { x: 1919, y: 540 },
      coordinateSpace: "pixels",
    });
  });

  it("leaves pixel actions untouched", () => {
    const action = { type: "click", point: { x: 12, y: 34 } } as const;
    expect(convertComputerActionCoordinates(action, 100, 100)).toEqual(action);
  });
});

describe("action signatures and display bounds", () => {
  it("ignores screenshot ids in duplicate detection signatures", () => {
    expect(
      computerActionSignature({ type: "click", point: { x: 10, y: 20 }, screenshotId: "a" }),
    ).toBe(computerActionSignature({ type: "click", point: { x: 10, y: 20 }, screenshotId: "b" }));
    expect(
      computerActionSignature({
        type: "click",
        point: { x: 10, y: 20 },
        coordinateSpace: "pixels",
      }),
    ).not.toBe(
      computerActionSignature({
        type: "click",
        point: { x: 10, y: 20 },
        coordinateSpace: "normalized",
      }),
    );
  });

  it("rejects points outside the current display", () => {
    expect(
      assertActionFitsDisplay(
        { type: "click", point: { x: 1919, y: 1079 } },
        {
          width: 1920,
          height: 1080,
        },
      ),
    ).toEqual({ ok: true, errors: [] });
    const outside = assertActionFitsDisplay(
      { type: "click", point: { x: 1920, y: 10 } },
      {
        width: 1920,
        height: 1080,
      },
    );
    expect(outside.ok).toBe(false);
  });
});
