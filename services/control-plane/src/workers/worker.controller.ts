import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import type {
  ConversationMessageRecord,
  WorkerArchiveBlockers,
  WorkerArchiveRecord,
  WorkerCreateRequest,
  WorkerModelSwitchRequest,
  WorkerPromptRequest,
  WorkerResumeRequest,
  WorkerResumeResult,
  WorkerSteerResult,
  WorkerView,
} from "@agent-in-box/protocol";
import { WorkerRegistryService } from "./worker-registry.service";
import { WorkerRuntimeService } from "./worker-runtime.service";

@Controller("/api/v1/workers")
export class WorkerController {
  constructor(
    private readonly workers: WorkerRuntimeService,
    private readonly registry: WorkerRegistryService,
  ) {}

  @Get()
  list(@Query("projectId") projectId?: string): Promise<WorkerView[]> {
    return this.workers.list(projectId?.trim() || undefined);
  }

  @Post()
  create(@Body() input: WorkerCreateRequest): Promise<WorkerView> {
    return this.workers.create(input);
  }

  @Get(":id")
  get(@Param("id") id: string): Promise<WorkerView> {
    return this.workers.get(id);
  }

  @Get(":id/messages")
  messages(
    @Param("id") id: string,
    @Query("limit") limit?: string,
  ): Promise<ConversationMessageRecord[]> {
    const parsed = limit === undefined ? 100 : Number(limit);
    return this.workers.messages(id, Number.isFinite(parsed) ? parsed : 100);
  }

  @Get(":id/blockers")
  blockers(@Param("id") id: string): Promise<WorkerArchiveBlockers> {
    return this.registry.archiveBlockers(id);
  }

  @Get(":id/archives")
  archives(
    @Param("id") id: string,
    @Query("limit") limit?: string,
  ): Promise<WorkerArchiveRecord[]> {
    const parsed = limit === undefined ? 25 : Number(limit);
    return this.registry.workerArchives(id, Number.isFinite(parsed) ? parsed : 25);
  }

  @Post(":id/prompt")
  prompt(
    @Param("id") id: string,
    @Body() input: WorkerPromptRequest,
  ): Promise<{ taskId: string; worker: WorkerView }> {
    return this.workers.prompt(id, input);
  }

  @Post(":id/steer")
  steer(@Param("id") id: string, @Body() input: WorkerPromptRequest): Promise<WorkerSteerResult> {
    return this.workers.steer(id, input);
  }

  @Post(":id/follow-up")
  followUp(
    @Param("id") id: string,
    @Body() input: WorkerPromptRequest,
  ): Promise<WorkerSteerResult> {
    return this.workers.followUp(id, input);
  }

  @Post(":id/abort")
  abort(@Param("id") id: string, @Body() body?: { reason?: string }): Promise<WorkerView> {
    return this.workers.abort(id, body?.reason?.trim() || undefined);
  }

  @Post(":id/archive")
  archive(@Param("id") id: string): Promise<WorkerView> {
    return this.workers.archive(id);
  }

  @Post(":id/switch-model")
  switchModel(
    @Param("id") id: string,
    @Body() input: WorkerModelSwitchRequest,
  ): Promise<WorkerView> {
    return this.workers.switchModel(id, input);
  }

  @Post(":id/resume")
  resume(@Param("id") id: string, @Body() body?: WorkerResumeRequest): Promise<WorkerResumeResult> {
    return this.workers.resume(id, body ?? {});
  }
}
