import { Body, Controller, Get, Headers, Param, Patch, Post, Query } from "@nestjs/common";
import {
  IDEMPOTENCY_KEY_HEADER,
  isTaskStatus,
  normalizePageRequest,
  type Page,
  type TaskArtifactRecord,
  type TaskBoardSnapshot,
  type TaskCreateRequest,
  type TaskCreateResult,
  type TaskDetail,
  type TaskListFilters,
  type TaskRecord,
} from "@agent-in-box/protocol";
import { PersistenceError } from "../persistence/errors";
import { TaskService } from "../persistence/services/task-service";
import { ResourceManagerService } from "../resources/resource-manager.service";

@Controller("/api/v1/tasks")
export class TaskController {
  constructor(
    private readonly tasks: TaskService,
    private readonly resources: ResourceManagerService,
  ) {}

  @Get("board")
  async board(
    @Query("projectId") projectId?: string,
    @Query("vmId") vmId?: string,
    @Query("workerId") workerId?: string,
    @Query("status") status?: string,
  ): Promise<TaskBoardSnapshot> {
    const [board, resources] = await Promise.all([
      this.tasks.board(parseFilters(projectId, vmId, workerId, status)),
      this.resources.report(),
    ]);
    return { ...board, resources };
  }

  @Get()
  list(
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
    @Query("projectId") projectId?: string,
    @Query("vmId") vmId?: string,
    @Query("workerId") workerId?: string,
    @Query("status") status?: string,
  ): Promise<Page<TaskRecord>> {
    return this.tasks.list(
      normalizePageRequest({
        ...(cursor !== undefined ? { cursor } : {}),
        ...(limit !== undefined ? { limit: Number(limit) } : {}),
      }),
      parseFilters(projectId, vmId, workerId, status),
    );
  }

  @Post()
  create(
    @Body() input: TaskCreateRequest,
    @Headers(IDEMPOTENCY_KEY_HEADER) idempotencyKey?: string,
  ): Promise<TaskCreateResult> {
    return this.tasks.create({ ...input, idempotencyKey: idempotencyKey ?? "" });
  }

  @Get(":id")
  detail(@Param("id") id: string): Promise<TaskDetail> {
    return this.tasks.detail(id);
  }

  @Patch(":id/priority")
  priority(@Param("id") id: string, @Body() body: { priority?: number }): Promise<TaskRecord> {
    return this.tasks.setPriority(id, body?.priority ?? Number.NaN);
  }

  @Post(":id/cancel")
  cancel(@Param("id") id: string, @Body() body?: { reason?: string }): Promise<TaskRecord> {
    return this.tasks.cancel(id, body?.reason);
  }

  @Post(":id/retry")
  retry(@Param("id") id: string): Promise<TaskRecord> {
    return this.tasks.retry(id);
  }

  @Post(":id/requeue")
  requeue(@Param("id") id: string): Promise<TaskRecord> {
    return this.tasks.requeue(id);
  }

  @Post(":id/artifacts/:artifactId/verify")
  verifyArtifact(
    @Param("id") id: string,
    @Param("artifactId") artifactId: string,
  ): Promise<TaskArtifactRecord> {
    return this.tasks.verifyArtifact(artifactId, id);
  }
}

function parseFilters(
  projectId?: string,
  vmId?: string,
  workerId?: string,
  status?: string,
): TaskListFilters {
  const statuses = status
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (statuses?.some((value) => !isTaskStatus(value))) {
    throw new PersistenceError("bad_request", "任务状态筛选值无效");
  }
  return {
    ...(projectId?.trim() ? { projectId: projectId.trim() } : {}),
    ...(vmId?.trim() ? { vmId: vmId.trim() } : {}),
    ...(workerId?.trim() ? { workerId: workerId.trim() } : {}),
    ...(statuses?.length ? { statuses: statuses.filter(isTaskStatus) } : {}),
  };
}
