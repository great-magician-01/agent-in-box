import { Module } from "@nestjs/common";
import { PersistenceModule } from "../persistence/persistence.module";
import { SettingsModule } from "../settings/settings.module";
import { DiagnosticsController } from "./diagnostics.controller";
import { DiagnosticsService } from "./diagnostics.service";

@Module({
  imports: [PersistenceModule, SettingsModule],
  controllers: [DiagnosticsController],
  providers: [DiagnosticsService],
})
export class DiagnosticsModule {}
