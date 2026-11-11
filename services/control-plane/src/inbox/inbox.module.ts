import { Module, type Provider } from "@nestjs/common";
import { PersistenceModule } from "../persistence/persistence.module";
import { InboxController } from "./inbox.controller";
import {
  DEFAULT_INBOX_MAX_BYTES,
  INBOX_OPTIONS,
  InboxService,
  type InboxOptions,
} from "./inbox.service";

const optionsProvider: Provider = {
  provide: INBOX_OPTIONS,
  useFactory: (): InboxOptions => {
    const raw = process.env.AGENT_IN_BOX_INBOX_MAX_BYTES?.trim();
    const parsed = raw ? Number(raw) : Number.NaN;
    return {
      maxBytes: Number.isFinite(parsed) && parsed >= 1024 ? parsed : DEFAULT_INBOX_MAX_BYTES,
    };
  },
};

@Module({
  imports: [PersistenceModule],
  controllers: [InboxController],
  providers: [optionsProvider, InboxService],
  exports: [InboxService],
})
export class InboxModule {}
