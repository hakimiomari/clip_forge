import { Module } from "@nestjs/common";
import { DownloadsController } from "./downloads.controller";
import { DownloadsService } from "./downloads.service";
import { StorageModule } from "../storage/storage.module";

@Module({
  imports: [StorageModule],
  controllers: [DownloadsController],
  providers: [DownloadsService],
})
export class DownloadsModule {}
