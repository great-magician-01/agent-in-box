import { Module } from "@nestjs/common";
import { HostModule } from "../host/host.module";
import { ImageModule } from "../images/image.module";
import { ModelsModule } from "../models/models.module";
import { PersistenceModule } from "../persistence/persistence.module";
import { ProjectModule } from "../projects/project.module";
import { RouterModule } from "../router/router.module";
import { SettingsModule } from "../settings/settings.module";
import { VmModule } from "../vms/vm.module";
import { BootstrapController } from "./bootstrap.controller";
import { BootstrapService } from "./bootstrap.service";

@Module({
  imports: [
    PersistenceModule,
    SettingsModule,
    ModelsModule,
    HostModule,
    ImageModule,
    VmModule,
    ProjectModule,
    RouterModule,
  ],
  controllers: [BootstrapController],
  providers: [BootstrapService],
  exports: [BootstrapService],
})
export class BootstrapModule {}
