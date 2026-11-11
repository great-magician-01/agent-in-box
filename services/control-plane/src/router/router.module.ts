import { Module } from "@nestjs/common";
import { ModelsModule } from "../models/models.module";
import { PersistenceModule } from "../persistence/persistence.module";
import { WorkerModule } from "../workers/worker.module";
import { RouterController } from "./router.controller";
import { RouterRuntimeService } from "./router-runtime.service";
import { RouterToolBrokerService } from "./router-tool-broker.service";
import { RouterToolService } from "./router-tool.service";

@Module({
  imports: [PersistenceModule, ModelsModule, WorkerModule],
  controllers: [RouterController],
  providers: [RouterToolService, RouterToolBrokerService, RouterRuntimeService],
  exports: [RouterRuntimeService, RouterToolService],
})
export class RouterModule {}
