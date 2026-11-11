import { Module, type Provider } from "@nestjs/common";
import { PersistenceModule } from "../persistence/persistence.module";
import { NotificationsController } from "./notifications.controller";
import {
  NOTIFICATION_OPTIONS,
  NotificationsService,
  type NotificationServiceOptions,
} from "./notifications.service";

const optionsProvider: Provider = {
  provide: NOTIFICATION_OPTIONS,
  useFactory: (): NotificationServiceOptions => {
    const raw = process.env.AGENT_IN_BOX_NOTIFICATION_TICK_MS?.trim();
    const parsed = raw ? Number(raw) : Number.NaN;
    return { pollIntervalMs: Number.isFinite(parsed) && parsed > 0 ? parsed : 500 };
  },
};

@Module({
  imports: [PersistenceModule],
  controllers: [NotificationsController],
  providers: [optionsProvider, NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
