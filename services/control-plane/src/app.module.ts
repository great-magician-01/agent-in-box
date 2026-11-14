import { Module } from "@nestjs/common";
import { AuthModule } from "./auth/auth.module";
import { PersistenceModule } from "./persistence/persistence.module";
import { HealthController } from "./health.controller";
import { RuntimeController } from "./runtime.controller";
import { SettingsModule } from "./settings/settings.module";
import { StorageModule } from "./storage/storage.module";
import { HostModule } from "./host/host.module";
import { OnboardingModule } from "./onboarding/onboarding.module";
import { ImageModule } from "./images/image.module";
import { VmModule } from "./vms/vm.module";
import { ProjectModule } from "./projects/project.module";
import { TaskModule } from "./tasks/task.module";
import { EventsModule } from "./events/events.module";
import { ModelsModule } from "./models/models.module";
import { ComputerUseModule } from "./computer-use/computer-use.module";
import { WorkerModule } from "./workers/worker.module";
import { RouterModule } from "./router/router.module";
import { ResourceModule } from "./resources/resources.module";
import { BotsModule } from "./bots/bots.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { InboxModule } from "./inbox/inbox.module";
import { DiagnosticsModule } from "./diagnostics/diagnostics.module";
import { BootstrapModule } from "./bootstrap/bootstrap.module";
import { PluginModule } from "./plugins/plugin.module";

@Module({
  imports: [
    PersistenceModule,
    AuthModule,
    SettingsModule,
    StorageModule,
    HostModule,
    OnboardingModule,
    ImageModule,
    VmModule,
    ProjectModule,
    TaskModule,
    EventsModule,
    ModelsModule,
    ComputerUseModule,
    ResourceModule,
    WorkerModule,
    RouterModule,
    BotsModule,
    NotificationsModule,
    InboxModule,
    DiagnosticsModule,
    BootstrapModule,
    PluginModule,
  ],
  controllers: [HealthController, RuntimeController],
})
export class AppModule {}
