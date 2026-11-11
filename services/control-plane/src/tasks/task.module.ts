import { Module } from "@nestjs/common";
import { PersistenceModule } from "../persistence/persistence.module";
import { TaskController } from "./task.controller";

@Module({
  imports: [PersistenceModule],
  controllers: [TaskController],
})
export class TaskModule {}
