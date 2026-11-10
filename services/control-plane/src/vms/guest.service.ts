import { Injectable } from "@nestjs/common";
import type {
  GuestActionRequest,
  GuestActionResult,
  GuestAgentCapabilities,
  GuestDesktopInfo,
  GuestHeartbeat,
  GuestScreenshot,
  GuestVersionHandshake,
} from "@agent-in-box/protocol";
import { PersistenceError } from "../persistence/errors";
import { LeaseService } from "../persistence/services/lease-service";
import { GuestClient, type GuestTarget } from "./guest.client";
import { SupervisorClient } from "./supervisor.client";
import { VmService } from "./vm.service";

@Injectable()
export class GuestService {
  constructor(
    private readonly vms: VmService,
    private readonly supervisor: SupervisorClient,
    private readonly leases: LeaseService,
    private readonly guest: GuestClient,
  ) {}

  async heartbeat(id: string): Promise<GuestHeartbeat> {
    return this.guest.heartbeat(await this.target(id));
  }

  async capabilities(id: string): Promise<GuestAgentCapabilities> {
    return this.guest.capabilities(await this.target(id));
  }

  async version(id: string): Promise<GuestVersionHandshake> {
    const handshake = await this.guest.version(await this.target(id));
    if (!handshake.compatible) {
      throw new PersistenceError(
        "unavailable",
        handshake.compatibilityError ?? "Guest Agent 协议版本不兼容",
      );
    }
    return handshake;
  }

  async desktop(id: string): Promise<GuestDesktopInfo> {
    return this.guest.desktop(await this.target(id));
  }

  async screenshot(id: string): Promise<GuestScreenshot> {
    return this.guest.screenshot(await this.target(id));
  }

  async input(id: string, request: GuestActionRequest): Promise<GuestActionResult> {
    if (
      !request ||
      typeof request.leaseId !== "string" ||
      !request.leaseId ||
      typeof request.action !== "object" ||
      request.action === null ||
      typeof request.action.type !== "string"
    ) {
      throw new PersistenceError("validation_failed", "Guest 动作必须包含 leaseId 和 action");
    }
    if (
      request.actionId !== undefined &&
      (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request.actionId) ||
        request.actionId.length > 128)
    ) {
      throw new PersistenceError("validation_failed", "actionId 格式无效");
    }
    if (
      request.timeoutMs !== undefined &&
      (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 30_000)
    ) {
      throw new PersistenceError("validation_failed", "Guest 动作超时必须为 1～30000 ms");
    }
    const target = await this.target(id);
    return this.leases.executeWithLease(id, request.leaseId, "worker", async () =>
      this.guest.input(target, request.action, request.actionId, request.timeoutMs),
    );
  }

  private async target(id: string): Promise<GuestTarget> {
    const vm = await this.vms.getRecord(id);
    const runtime = await this.supervisor.get(id);
    if (runtime.powerState !== "running") {
      throw new PersistenceError("conflict", "只有运行中的 VM 可以使用 Guest Agent");
    }
    return { hostPort: runtime.guestHostPort, storageRoot: vm.storageRoot };
  }
}
