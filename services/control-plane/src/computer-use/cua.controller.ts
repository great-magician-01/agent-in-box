import { Body, Controller, Get, Param, Post, Put, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import type {
  CuaApprovalRecord,
  CuaApprovalResolveRequest,
  CuaApprovalStatus,
  CuaPolicyUpdateRequest,
  CuaPolicyView,
  TaskTraceView,
} from "@agent-in-box/protocol";
import { PersistenceError } from "../persistence/errors";
import { ApprovalService } from "./approval.service";
import { CuaExecutionService } from "./cua-execution.service";
import { CuaPolicyService } from "./cua-policy.service";

@Controller("/api/v1/tasks")
export class CuaTaskController {
  constructor(private readonly execution: CuaExecutionService) {}

  @Get(":id/trace")
  trace(@Param("id") id: string): Promise<TaskTraceView> {
    return this.execution.trace(id);
  }

  @Get(":id/screenshots/:screenshotId")
  async screenshot(
    @Param("id") id: string,
    @Param("screenshotId") screenshotId: string,
    @Res() response: Response,
  ): Promise<void> {
    const result = await this.execution.readScreenshot(id, screenshotId);
    response.setHeader("Content-Type", "image/png");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Length", String(result.data.byteLength));
    response.end(result.data);
  }
}

@Controller("/api/v1/approvals")
export class CuaApprovalController {
  constructor(private readonly approvals: ApprovalService) {}

  @Get()
  list(
    @Query("status") status?: string,
    @Query("taskId") taskId?: string,
  ): Promise<CuaApprovalRecord[]> {
    const parsed = status?.trim() || undefined;
    if (
      parsed !== undefined &&
      !["pending", "approved", "rejected", "timed_out", "cancelled"].includes(parsed)
    ) {
      throw new PersistenceError("bad_request", "审批状态筛选值无效");
    }
    return this.approvals.list({
      ...(parsed ? { status: parsed as CuaApprovalStatus } : {}),
      ...(taskId?.trim() ? { taskId: taskId.trim() } : {}),
    });
  }

  @Get(":id")
  get(@Param("id") id: string): Promise<CuaApprovalRecord> {
    return this.approvals.get(id);
  }

  @Post(":id/approve")
  approve(
    @Param("id") id: string,
    @Body() body?: CuaApprovalResolveRequest,
  ): Promise<CuaApprovalRecord> {
    return this.approvals.resolve(id, "approved", "local-user", body?.note);
  }

  @Post(":id/reject")
  reject(
    @Param("id") id: string,
    @Body() body?: CuaApprovalResolveRequest,
  ): Promise<CuaApprovalRecord> {
    return this.approvals.resolve(id, "rejected", "local-user", body?.note);
  }
}

@Controller("/api/v1/projects")
export class CuaPolicyController {
  constructor(private readonly policies: CuaPolicyService) {}

  @Get(":id/policy")
  get(@Param("id") id: string): Promise<CuaPolicyView> {
    return this.policies.view(id);
  }

  @Put(":id/policy")
  update(@Param("id") id: string, @Body() input: CuaPolicyUpdateRequest): Promise<CuaPolicyView> {
    return this.policies.update(id, input ?? {});
  }
}
