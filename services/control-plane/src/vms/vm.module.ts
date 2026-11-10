import { Module } from "@nestjs/common";
import { ImageModule } from "../images/image.module";
import { PersistenceModule } from "../persistence/persistence.module";
import { SupervisorClient } from "./supervisor.client";
import { VmController } from "./vm.controller";
import { VmService } from "./vm.service";

@Module({
  imports: [PersistenceModule, ImageModule],
  controllers: [VmController],
  providers: [SupervisorClient, VmService],
  exports: [VmService],
})
export class VmModule {}
