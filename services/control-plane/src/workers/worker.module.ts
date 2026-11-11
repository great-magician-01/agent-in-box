import { Module } from "@nestjs/common";
import { ComputerUseModule } from "../computer-use/computer-use.module";
import { ModelsModule } from "../models/models.module";
import { PersistenceModule } from "../persistence/persistence.module";
import { VmModule } from "../vms/vm.module";
import { WorkerController } from "./worker.controller";
import { WorkerRuntimeService } from "./worker-runtime.service";

@Module({
  imports: [PersistenceModule, VmModule, ModelsModule, ComputerUseModule],
  controllers: [WorkerController],
  providers: [WorkerRuntimeService],
  exports: [WorkerRuntimeService],
})
export class WorkerModule {}
