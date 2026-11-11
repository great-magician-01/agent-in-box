import {
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { Request, Response } from "express";
import type { InboxFileListResponse, InboxFileRecord } from "@agent-in-box/protocol";
import { InboxService } from "./inbox.service";

@Controller("/api/v1/inbox")
export class InboxController {
  constructor(private readonly inbox: InboxService) {}

  @Get("info")
  info(): { directory: string; maxBytes: number } {
    return { directory: this.inbox.directory(), maxBytes: this.inbox.maxUploadBytes() };
  }

  @Get()
  async list(
    @Query("projectId") projectId?: string,
    @Query("limit") limit?: string,
  ): Promise<InboxFileListResponse> {
    const parsed = limit === undefined ? 200 : Number(limit);
    return {
      items: await this.inbox.list({
        ...(projectId?.trim() ? { projectId: projectId.trim() } : {}),
        limit: Number.isFinite(parsed) ? parsed : 200,
      }),
    };
  }

  /**
   * Raw-body upload used by the drag-and-drop panel. The route is deliberately
   * not multipart: the browser and Electron shell both stream the File object
   * directly, and the control plane writes it to the data-root inbox.
   */
  @Post("upload")
  @HttpCode(HttpStatus.OK)
  async upload(
    @Req() request: Request,
    @Headers("x-file-name") fileName?: string,
    @Headers("x-project-id") projectId?: string,
    @Headers("content-type") contentType?: string,
  ): Promise<InboxFileRecord> {
    const declaredHeader = request.headers["content-length"];
    const declaredBytes =
      typeof declaredHeader === "string" && declaredHeader.trim() !== ""
        ? Number(declaredHeader)
        : null;
    return this.inbox.upload({
      fileName: fileName?.trim() || "dropped-file",
      contentType: contentType ?? "application/octet-stream",
      projectId: projectId?.trim() || null,
      stream: request,
      declaredBytes,
    });
  }

  @Get(":id/content")
  async download(@Param("id") id: string, @Res() response: Response): Promise<void> {
    const { record, stream } = await this.inbox.stream(id);
    response.setHeader("Content-Type", record.contentType);
    response.setHeader("Content-Length", String(record.sizeBytes));
    response.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(record.originalName)}`,
    );
    response.setHeader("Cache-Control", "no-store");
    stream.on("error", () => response.destroy());
    stream.pipe(response);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.OK)
  async remove(@Param("id") id: string): Promise<InboxFileRecord> {
    return this.inbox.remove(id);
  }
}
