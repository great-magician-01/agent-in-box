import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { RuntimeController } from "./runtime.controller";

@Module({
  controllers: [HealthController, RuntimeController],
})
export class AppModule {}
