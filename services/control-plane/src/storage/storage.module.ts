import { Module } from "@nestjs/common";
import { PersistenceModule } from "../persistence/persistence.module";
import { StorageController } from "./storage.controller";
import { STORAGE_OPTIONS, StorageService } from "./storage.service";

@Module({
  imports: [PersistenceModule],
  controllers: [StorageController],
  providers: [{ provide: STORAGE_OPTIONS, useValue: {} }, StorageService],
  exports: [StorageService],
})
export class StorageModule {}
