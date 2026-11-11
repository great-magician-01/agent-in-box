import { Module } from "@nestjs/common";
import { ComputerUseModule } from "../computer-use/computer-use.module";
import { ModelsModule } from "../models/models.module";
import { PersistenceModule } from "../persistence/persistence.module";
import { SettingsModule } from "../settings/settings.module";
import { VmModule } from "../vms/vm.module";
import { WorkerController } from "./worker.controller";
import { WorkerRegistryController } from "./worker-registry.controller";
import { WorkerRegistryService } from "./worker-registry.service";
import { WorkerRuntimeService } from "./worker-runtime.service";

@Module({
  imports: [PersistenceModule, VmModule, ModelsModule, ComputerUseModule, SettingsModule],
  controllers: [WorkerController, WorkerRegistryController],
  providers: [WorkerRuntimeService, WorkerRegistryService],
  exports: [WorkerRuntimeService, WorkerRegistryService],
})
export class WorkerModule {}
