import { Module } from "@nestjs/common";
import { PersistenceModule } from "../persistence/persistence.module";
import { SettingsModule } from "../settings/settings.module";
import { SupervisorModule } from "../vms/supervisor.module";
import { ResourceController } from "./resource.controller";
import { ResourceManagerService } from "./resource-manager.service";

@Module({
  imports: [PersistenceModule, SettingsModule, SupervisorModule],
  controllers: [ResourceController],
  providers: [ResourceManagerService],
  exports: [ResourceManagerService],
})
export class ResourceModule {}
