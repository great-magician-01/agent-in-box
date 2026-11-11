import { Module } from "@nestjs/common";
import { PersistenceModule } from "../persistence/persistence.module";
import { VmModule } from "../vms/vm.module";
import { ProjectBackupService } from "./project-backup.service";
import { ProjectController } from "./project.controller";
import { ProjectService } from "./project.service";

@Module({
  imports: [PersistenceModule, VmModule],
  controllers: [ProjectController],
  providers: [ProjectService, ProjectBackupService],
  exports: [ProjectService, ProjectBackupService],
})
export class ProjectModule {}
