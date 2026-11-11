import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import type {
  ConversationRecord,
  ProjectBindingRequest,
  ProjectBindingUpdateRequest,
  ProjectCreateRequest,
  ProjectDetail,
  ProjectUpdateRequest,
  ProjectView,
} from "@agent-in-box/protocol";
import { ProjectService } from "./project.service";

@Controller("/api/v1/projects")
export class ProjectController {
  constructor(private readonly projects: ProjectService) {}

  @Get()
  list(@Query("includeArchived") includeArchived?: string): Promise<ProjectView[]> {
    return this.projects.list(includeArchived === "true");
  }

  @Post()
  create(@Body() input: ProjectCreateRequest): Promise<ProjectDetail> {
    return this.projects.create(input);
  }

  @Get(":id")
  get(@Param("id") id: string): Promise<ProjectDetail> {
    return this.projects.get(id);
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() input: ProjectUpdateRequest): Promise<ProjectDetail> {
    return this.projects.update(id, input ?? {});
  }

  @Post(":id/archive")
  archive(@Param("id") id: string): Promise<ProjectDetail> {
    return this.projects.setArchived(id, true);
  }

  @Post(":id/restore")
  restore(@Param("id") id: string): Promise<ProjectDetail> {
    return this.projects.setArchived(id, false);
  }

  @Delete(":id")
  delete(@Param("id") id: string): Promise<{ deleted: true; projectId: string }> {
    return this.projects.delete(id);
  }

  @Post(":id/bindings")
  bind(@Param("id") id: string, @Body() input: ProjectBindingRequest): Promise<ProjectDetail> {
    return this.projects.bind(id, input);
  }

  @Patch(":id/bindings/:bindingId")
  updateBinding(
    @Param("id") id: string,
    @Param("bindingId") bindingId: string,
    @Body() input: ProjectBindingUpdateRequest,
  ): Promise<ProjectDetail> {
    return this.projects.updateBinding(id, bindingId, input ?? {});
  }

  @Delete(":id/bindings/:bindingId")
  unbind(@Param("id") id: string, @Param("bindingId") bindingId: string): Promise<ProjectDetail> {
    return this.projects.unbind(id, bindingId);
  }

  @Post(":id/conversations")
  conversation(
    @Param("id") id: string,
    @Body() body: { title?: string },
  ): Promise<ConversationRecord> {
    return this.projects.createConversation(id, body?.title ?? "");
  }
}
