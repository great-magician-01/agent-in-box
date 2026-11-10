import { Module } from "@nestjs/common";
import { ImageModule } from "../images/image.module";
import { PersistenceModule } from "../persistence/persistence.module";
import { ConsoleService } from "./console.service";
import { ExecutionController } from "./execution.controller";
import { GuestClient } from "./guest.client";
import { GuestController } from "./guest.controller";
import { GuestService } from "./guest.service";
import { SupervisorClient } from "./supervisor.client";
import { VmController } from "./vm.controller";
import { VmService } from "./vm.service";

@Module({
  imports: [PersistenceModule, ImageModule],
  controllers: [VmController, ExecutionController, GuestController],
  providers: [SupervisorClient, VmService, ConsoleService, GuestClient, GuestService],
  exports: [VmService, ConsoleService, GuestService],
})
export class VmModule {}
