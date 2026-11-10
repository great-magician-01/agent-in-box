import type { HealthResponse, IsoTimestamp } from "@agent-in-box/protocol";
import { PROTOCOL_VERSION } from "@agent-in-box/protocol";

export function buildHealthResponse(
  startedAt: Date = new Date(),
  now: Date = new Date(),
): HealthResponse {
  return {
    status: "ok",
    service: "control-plane",
    protocolVersion: PROTOCOL_VERSION,
    startedAt: startedAt.toISOString() as IsoTimestamp,
    now: now.toISOString() as IsoTimestamp,
  };
}
