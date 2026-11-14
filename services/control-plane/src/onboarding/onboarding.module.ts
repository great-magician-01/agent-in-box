import { Module } from "@nestjs/common";
import { SettingsModule } from "../settings/settings.module";
import { StorageModule } from "../storage/storage.module";
import { OnboardingController } from "./onboarding.controller";
import { OnboardingService } from "./onboarding.service";

@Module({
  imports: [SettingsModule, StorageModule],
  controllers: [OnboardingController],
  providers: [OnboardingService],
})
export class OnboardingModule {}
