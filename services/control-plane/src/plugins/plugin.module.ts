import { Module } from "@nestjs/common";
import { PersistenceModule } from "../persistence/persistence.module";
import { PluginController } from "./plugin.controller";
import { PluginService } from "./plugin.service";
import { PluginDevelopmentService } from "./plugin-development.service";

@Module({
  imports: [PersistenceModule],
  controllers: [PluginController],
  providers: [PluginService, PluginDevelopmentService],
  exports: [PluginService, PluginDevelopmentService],
})
export class PluginModule {}
