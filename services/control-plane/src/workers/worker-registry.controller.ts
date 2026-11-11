import { Controller, Get, Param, Query } from "@nestjs/common";
import type {
  ActiveRosterView,
  WorkerArchiveRecord,
  WorkerArchiveSearchResult,
  WorkerRelationView,
  WorkerSummaryView,
} from "@agent-in-box/protocol";
import { PersistenceError } from "../persistence/errors";
import { WorkerRegistryService } from "./worker-registry.service";

@Controller("/api/v1/registry")
export class WorkerRegistryController {
  constructor(private readonly registry: WorkerRegistryService) {}

  @Get("workers")
  async roster(@Query("projectId") projectId?: string): Promise<ActiveRosterView> {
    return this.registry.activeRoster(projectId?.trim() || undefined);
  }

  @Get("workers/:id/summary")
  summary(@Param("id") id: string): Promise<WorkerSummaryView> {
    return this.registry.summary(id);
  }

  @Get("workers/:id/archives")
  archives(
    @Param("id") id: string,
    @Query("limit") limit?: string,
  ): Promise<WorkerArchiveRecord[]> {
    return this.registry.workerArchives(id, parseLimit(limit, 25));
  }

  @Get("archives")
  search(
    @Query("projectId") projectId?: string,
    @Query("query") query?: string,
    @Query("limit") limit?: string,
  ): Promise<WorkerArchiveSearchResult> {
    return this.registry.searchArchives({
      ...(projectId?.trim() ? { projectId: projectId.trim() } : {}),
      ...(query?.trim() ? { query: query.trim() } : {}),
      limit: parseLimit(limit, 25),
    });
  }

  @Get("find-related")
  findRelated(
    @Query("conversationId") conversationId?: string,
    @Query("objective") objective?: string,
    @Query("projectId") projectId?: string,
  ): Promise<WorkerRelationView> {
    if (!conversationId?.trim()) {
      throw new PersistenceError("validation_failed", "conversationId 不能为空");
    }
    return this.registry.findRelatedWorker({
      conversationId: conversationId.trim(),
      objective: objective ?? "",
      ...(projectId?.trim() ? { projectId: projectId.trim() } : {}),
    });
  }
}

function parseLimit(raw: string | undefined, fallback: number): number {
  const value = raw === undefined ? fallback : Number(raw);
  return Number.isFinite(value) ? value : fallback;
}
