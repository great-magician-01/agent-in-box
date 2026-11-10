import { Module } from "@nestjs/common";
import { PersistenceModule } from "../persistence/persistence.module";
import { HostController } from "./host.controller";
import { HostInspectionService } from "./host-inspection.service";

@Module({
  imports: [PersistenceModule],
  controllers: [HostController],
  providers: [HostInspectionService],
  exports: [HostInspectionService],
})
export class HostModule {}
