import { Module } from "@nestjs/common";
import { PersistenceModule } from "../persistence/persistence.module";
import { ProjectController } from "./project.controller";
import { ProjectService } from "./project.service";

@Module({
  imports: [PersistenceModule],
  controllers: [ProjectController],
  providers: [ProjectService],
  exports: [ProjectService],
})
export class ProjectModule {}
