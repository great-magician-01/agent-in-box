import { describe, expect, it } from "vitest";
import { assertPiLaunchSupported, resolvePiLaunch } from "./pi-launch";

describe("resolvePiLaunch", () => {
  it("uses the normal pi shim by default", () => {
    expect(resolvePiLaunch({}, "C:\\node\\node.exe")).toEqual({
      command: "pi",
      argsPrefix: [],
    });
  });

  it("uses the configured binary when only a binary is set", () => {
    expect(
      resolvePiLaunch({ AGENT_IN_BOX_PI_BINARY: "C:\\tools\\pi.exe" }, "C:\\node\\node.exe"),
    ).toEqual({ command: "C:\\tools\\pi.exe", argsPrefix: [] });
  });

  it("runs the Pi CLI script with Node so Windows .cmd shims are not spawned directly", () => {
    expect(
      resolvePiLaunch(
        {
          AGENT_IN_BOX_PI_SCRIPT: "C:\\AIB\\worker\\node_modules\\pi\\cli.js",
        },
        "C:\\AIB\\node\\node.exe",
      ),
    ).toEqual({
      command: "C:\\AIB\\node\\node.exe",
      argsPrefix: ["C:\\AIB\\worker\\node_modules\\pi\\cli.js"],
    });
  });

  it("rejects an empty resolved command", () => {
    expect(() => assertPiLaunchSupported({ command: " ", argsPrefix: [] })).toThrow(
      "launch command is empty",
    );
  });
});
