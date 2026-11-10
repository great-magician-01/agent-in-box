import { Module } from "@nestjs/common";
import { PersistenceModule } from "./persistence/persistence.module";
import { HealthController } from "./health.controller";
import { RuntimeController } from "./runtime.controller";

@Module({
  imports: [PersistenceModule],
  controllers: [HealthController, RuntimeController],
})
export class AppModule {}
