import { Module } from "@nestjs/common";
import { PersistenceModule } from "../persistence/persistence.module";
import { SettingsModule } from "../settings/settings.module";
import { VmModule } from "../vms/vm.module";
import { ApprovalService } from "./approval.service";
import { CuaBrokerService } from "./cua-broker.service";
import {
  CuaApprovalController,
  CuaPolicyController,
  CuaTaskController,
  HumanVerificationController,
} from "./cua.controller";
import { CuaExecutionService } from "./cua-execution.service";
import { CuaPolicyService } from "./cua-policy.service";
import { CuaTokenService } from "./cua-token.service";

@Module({
  imports: [PersistenceModule, SettingsModule, VmModule],
  controllers: [
    CuaTaskController,
    CuaApprovalController,
    CuaPolicyController,
    HumanVerificationController,
  ],
  providers: [
    CuaPolicyService,
    ApprovalService,
    CuaTokenService,
    CuaExecutionService,
    CuaBrokerService,
  ],
  exports: [
    CuaPolicyService,
    ApprovalService,
    CuaTokenService,
    CuaExecutionService,
    CuaBrokerService,
  ],
})
export class ComputerUseModule {}
