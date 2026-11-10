import { Controller, Get, Param, Post, Sse, type MessageEvent } from "@nestjs/common";
import type { ImageCatalog, ImageRecord } from "@agent-in-box/protocol";
import { map, type Observable } from "rxjs";
import { ImageService } from "./image.service";

@Controller("/api/v1/images")
export class ImageController {
  constructor(private readonly images: ImageService) {}

  @Get()
  list(): Promise<ImageCatalog> {
    return this.images.list();
  }

  @Sse("events")
  events(): Observable<MessageEvent> {
    return this.images.events.pipe(map((event) => ({ data: event })));
  }

  @Post("manifest/refresh")
  refresh(): Promise<ImageCatalog> {
    return this.images.refresh();
  }

  @Get(":id")
  get(@Param("id") id: string): Promise<ImageRecord> {
    return this.images.get(id);
  }

  @Post(":id/download")
  download(@Param("id") id: string): Promise<ImageRecord> {
    return this.images.download(id);
  }

  @Post(":id/cancel")
  cancel(@Param("id") id: string): Promise<ImageRecord> {
    return this.images.cancel(id);
  }
}
