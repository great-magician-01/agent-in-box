import { describe, expect, it } from "vitest";
import { buildHealthResponse } from "./health";

describe("buildHealthResponse", () => {
  it("reports the control plane and protocol version", () => {
    const startedAt = new Date("2026-11-10T00:00:00.000Z");
    const now = new Date("2026-11-10T00:00:05.000Z");
    const response = buildHealthResponse(startedAt, now);

    expect(response.status).toBe("ok");
    expect(response.service).toBe("control-plane");
    expect(response.protocolVersion).toBe("0.1.0");
    expect(response.startedAt).toBe("2026-11-10T00:00:00.000Z");
    expect(response.now).toBe("2026-11-10T00:00:05.000Z");
  });
});
