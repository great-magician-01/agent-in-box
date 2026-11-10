import { Module } from "@nestjs/common";
import { PersistenceModule } from "../persistence/persistence.module";
import { SettingsService } from "./settings.service";

@Module({
  imports: [PersistenceModule],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
