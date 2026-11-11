import { Module } from "@nestjs/common";
import { PersistenceModule } from "../persistence/persistence.module";
import { ResourceModule } from "../resources/resources.module";
import { TaskController } from "./task.controller";

@Module({
  imports: [PersistenceModule, ResourceModule],
  controllers: [TaskController],
})
export class TaskModule {}
