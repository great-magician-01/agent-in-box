import { Module } from "@nestjs/common";
import { PersistenceModule } from "./persistence/persistence.module";
import { HealthController } from "./health.controller";
import { RuntimeController } from "./runtime.controller";
import { SettingsModule } from "./settings/settings.module";
import { StorageModule } from "./storage/storage.module";
import { HostModule } from "./host/host.module";
import { OnboardingModule } from "./onboarding/onboarding.module";
import { ImageModule } from "./images/image.module";
import { VmModule } from "./vms/vm.module";

@Module({
  imports: [
    PersistenceModule,
    SettingsModule,
    StorageModule,
    HostModule,
    OnboardingModule,
    ImageModule,
    VmModule,
  ],
  controllers: [HealthController, RuntimeController],
})
export class AppModule {}
