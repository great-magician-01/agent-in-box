import { Controller, Get } from "@nestjs/common";
import { defaultDataRoot, storageLayout } from "@agent-in-box/config";
import { DatabaseService } from "./persistence/database.service";

export interface RuntimeInfo {
  platform: string;
  architecture: string;
  dataRoot: string;
  databasePath: string;
  storage: {
    images: string;
    vms: string;
    snapshots: string;
    archives: string;
  };
}

@Controller("api/v1")
export class RuntimeController {
  constructor(private readonly database: DatabaseService) {}

  @Get("runtime")
  runtime(): RuntimeInfo {
    const layout = storageLayout(defaultDataRoot());
    return {
      platform: process.platform,
      architecture: process.arch,
      dataRoot: layout.root,
      databasePath: this.database.filename,
      storage: {
        images: layout.images,
        vms: layout.vms,
        snapshots: layout.snapshots,
        archives: layout.archives,
      },
    };
  }
}
