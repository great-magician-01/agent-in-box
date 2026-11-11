import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PersistenceModule } from "../persistence/persistence.module";
import { EventsService } from "./events.service";

@Module({
  imports: [PersistenceModule, AuthModule],
  providers: [EventsService],
  exports: [EventsService],
})
export class EventsModule {}
