import path from "node:path";
import { Module, type Provider } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { PersistenceModule } from "../persistence/persistence.module";
import { DatabaseService } from "../persistence/database.service";
import { AuthController } from "./auth.controller";
import { AuthGuard } from "./auth.guard";
import { AUTH_OPTIONS, AuthService, type AuthOptions } from "./auth.service";

const authOptionsProvider: Provider = {
  provide: AUTH_OPTIONS,
  useFactory: (database: DatabaseService): AuthOptions => ({
    accessKeyPath: path.join(path.dirname(database.configPath), "web-access-key"),
  }),
  inject: [DatabaseService],
};

@Module({
  imports: [PersistenceModule],
  controllers: [AuthController],
  providers: [authOptionsProvider, AuthService, { provide: APP_GUARD, useClass: AuthGuard }],
  exports: [AuthService],
})
export class AuthModule {}
