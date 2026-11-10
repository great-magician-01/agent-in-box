import { Controller, Get } from "@nestjs/common";
import type { RuntimeInfo } from "@agent-in-box/protocol";
import { DatabaseService } from "./persistence/database.service";

@Controller("api/v1")
export class RuntimeController {
  constructor(private readonly database: DatabaseService) {}

  @Get("runtime")
  runtime(): RuntimeInfo {
    return {
      platform: process.platform,
      architecture: process.arch,
      dataRoot: this.database.dataRoot,
      dataRootSource: this.database.dataRootSource,
      configPath: this.database.configPath,
      databasePath: this.database.filename,
      storage: {
        images: this.database.layout.images,
        downloads: this.database.layout.downloads,
        vms: this.database.layout.vms,
        snapshots: this.database.layout.snapshots,
        artifacts: this.database.layout.artifacts,
        archives: this.database.layout.archives,
      },
    };
  }
}
