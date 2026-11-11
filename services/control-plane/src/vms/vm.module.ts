import { Module } from "@nestjs/common";
import { ImageModule } from "../images/image.module";
import { PersistenceModule } from "../persistence/persistence.module";
import { ResourceModule } from "../resources/resources.module";
import { ConsoleService } from "./console.service";
import { ExecutionController } from "./execution.controller";
import { GuestClient } from "./guest.client";
import { GuestController } from "./guest.controller";
import { GuestService } from "./guest.service";
import { SnapshotService } from "./snapshot.service";
import { SupervisorModule } from "./supervisor.module";
import { VmController } from "./vm.controller";
import { VmService } from "./vm.service";

@Module({
  imports: [PersistenceModule, ImageModule, SupervisorModule, ResourceModule],
  controllers: [VmController, ExecutionController, GuestController],
  providers: [VmService, SnapshotService, ConsoleService, GuestClient, GuestService],
  exports: [
    SupervisorModule,
    VmService,
    SnapshotService,
    ConsoleService,
    GuestService,
    GuestClient,
  ],
})
export class VmModule {}
