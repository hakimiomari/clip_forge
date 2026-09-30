import { Module } from "@nestjs/common";
import { PhotosController } from "./photos.controller";
import { PhotosService } from "./photos.service";
import { StorageModule } from "../storage/storage.module";

@Module({
  imports: [StorageModule],
  controllers: [PhotosController],
  providers: [PhotosService],
})
export class PhotosModule {}
