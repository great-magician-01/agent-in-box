import { Module } from "@nestjs/common";
import { PersistenceModule } from "../persistence/persistence.module";
import { EventsService } from "./events.service";

@Module({
  imports: [PersistenceModule],
  providers: [EventsService],
  exports: [EventsService],
})
export class EventsModule {}
