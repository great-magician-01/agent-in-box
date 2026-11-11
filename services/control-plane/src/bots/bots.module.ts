import { Module } from "@nestjs/common";
import { ComputerUseModule } from "../computer-use/computer-use.module";
import { HostCredentialProvider } from "../models/credential-provider";
import { PersistenceModule } from "../persistence/persistence.module";
import { ProjectModule } from "../projects/project.module";
import { ResourceModule } from "../resources/resources.module";
import { RouterModule } from "../router/router.module";
import { SettingsModule } from "../settings/settings.module";
import { BotAccountService } from "./bot-account.service";
import { BotCommandService } from "./bot-command.service";
import { BotConnectorService, BOT_CREDENTIAL_PROVIDER } from "./bot-connector.service";
import { BotController } from "./bot.controller";
import { BotIdentityService } from "./bot-identity.service";
import { BotIngressDispatcherService } from "./bot-ingress.service";
import { BotNotificationService } from "./bot-notification.service";
import { BotOutboundService } from "./bot-outbound.service";
import { BotOverviewService } from "./bot-overview.service";

@Module({
  imports: [
    PersistenceModule,
    SettingsModule,
    RouterModule,
    ComputerUseModule,
    ProjectModule,
    ResourceModule,
  ],
  controllers: [BotController],
  providers: [
    BotAccountService,
    BotIdentityService,
    BotOutboundService,
    BotOverviewService,
    {
      provide: BOT_CREDENTIAL_PROVIDER,
      useFactory: () => {
        const developmentCredentialsFile =
          process.env.AGENT_IN_BOX_BOT_CREDENTIALS_FILE?.trim() ||
          process.env.AGENT_IN_BOX_MODEL_CREDENTIALS_FILE?.trim();
        return new HostCredentialProvider({
          purpose: "机器人",
          ...(developmentCredentialsFile ? { developmentCredentialsFile } : {}),
        });
      },
    },
    BotConnectorService,
    BotCommandService,
    BotIngressDispatcherService,
    BotNotificationService,
  ],
  exports: [
    BotAccountService,
    BotIdentityService,
    BotConnectorService,
    BotIngressDispatcherService,
    BotOutboundService,
    BotNotificationService,
    BotOverviewService,
    BOT_CREDENTIAL_PROVIDER,
  ],
})
export class BotsModule {}
