import { Module } from "@nestjs/common";
import { PersistenceModule } from "../persistence/persistence.module";
import { SupervisorClient } from "./supervisor.client";

@Module({
  imports: [PersistenceModule],
  providers: [SupervisorClient],
  exports: [SupervisorClient],
})
export class SupervisorModule {}
