import { Module } from "@nestjs/common";
import { HostModule } from "../host/host.module";
import { SettingsModule } from "../settings/settings.module";
import { StorageModule } from "../storage/storage.module";
import { OnboardingController } from "./onboarding.controller";
import { OnboardingService } from "./onboarding.service";

@Module({
  imports: [SettingsModule, StorageModule, HostModule],
  controllers: [OnboardingController],
  providers: [OnboardingService],
})
export class OnboardingModule {}
