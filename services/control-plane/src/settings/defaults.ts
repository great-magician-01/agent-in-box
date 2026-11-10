import type { ResourcePolicy, SecuritySettings } from "@agent-in-box/protocol";

export const GIB = 1024 * 1024 * 1024;

export const MIN_HOST_RESERVE_BYTES = 512 * 1024 * 1024;

export function defaultResourcePolicy(totalMemoryBytes: number): ResourcePolicy {
  const quarter = Math.floor(totalMemoryBytes / 4);
  const reserve = Math.min(4 * GIB, Math.max(GIB, quarter));
  return {
    hostReserveBytes: totalMemoryBytes > 0 ? Math.min(reserve, totalMemoryBytes) : reserve,
    autoStartPolicy: "manual",
  };
}

export const DEFAULT_SECURITY_SETTINGS: SecuritySettings = {
  requireApprovalForSensitiveActions: true,
};
