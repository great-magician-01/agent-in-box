import { Module } from "@nestjs/common";
import { PersistenceModule } from "../persistence/persistence.module";
import { ImageController } from "./image.controller";
import { ImageService } from "./image.service";

@Module({
  imports: [PersistenceModule],
  controllers: [ImageController],
  providers: [ImageService],
  exports: [ImageService],
})
export class ImageModule {}
