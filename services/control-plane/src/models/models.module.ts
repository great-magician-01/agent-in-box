import { Module } from "@nestjs/common";
import { PersistenceModule } from "../persistence/persistence.module";
import { HostCredentialProvider } from "./credential-provider";
import { ModelBrokerService } from "./model-broker.service";
import { ModelController } from "./model.controller";
import { ModelProviderService } from "./model-provider.service";
import { ModelTokenService } from "./model-token.service";
import { MODEL_CREDENTIAL_PROVIDER } from "./tokens";

@Module({
  imports: [PersistenceModule],
  controllers: [ModelController],
  providers: [
    ModelProviderService,
    ModelTokenService,
    {
      provide: MODEL_CREDENTIAL_PROVIDER,
      useFactory: () => new HostCredentialProvider(),
    },
    ModelBrokerService,
  ],
  exports: [ModelProviderService, ModelTokenService, ModelBrokerService, MODEL_CREDENTIAL_PROVIDER],
})
export class ModelsModule {}
