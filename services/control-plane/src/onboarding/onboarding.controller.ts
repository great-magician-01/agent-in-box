import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post } from "@nestjs/common";
import type {
  OnboardingCompleteResult,
  OnboardingState,
  SettingsView,
} from "@agent-in-box/protocol";
import { OnboardingService } from "./onboarding.service";

@Controller("api/v1")
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get("onboarding")
  state(): Promise<OnboardingState> {
    return this.onboarding.state();
  }

  @Post("onboarding/complete")
  @HttpCode(HttpStatus.OK)
  complete(@Body() body: unknown): Promise<OnboardingCompleteResult> {
    return this.onboarding.complete(body);
  }

  @Get("settings")
  async settings(): Promise<SettingsView> {
    const onboarding = await this.onboarding.state();
    return {
      resourcePolicy: onboarding.resourcePolicy,
      security: onboarding.security,
      workerLifecycle: await this.onboarding.workerLifecyclePolicy(),
      dataRoot: onboarding.dataRoot,
      dataRootSource: onboarding.dataRootSource,
      onboarding,
    };
  }

  @Patch("settings")
  async updateSettings(@Body() body: unknown): Promise<SettingsView> {
    const onboarding = await this.onboarding.updateSettings(body);
    return {
      resourcePolicy: onboarding.resourcePolicy,
      security: onboarding.security,
      workerLifecycle: await this.onboarding.workerLifecyclePolicy(),
      dataRoot: onboarding.dataRoot,
      dataRootSource: onboarding.dataRootSource,
      onboarding,
    };
  }
}
