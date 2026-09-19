import { Module } from "@nestjs/common";
import { ClipsController } from "./clips.controller";
import { ClipsService } from "./clips.service";
import { HighlightsModule } from "../highlights/highlights.module";
import { StorageModule } from "../storage/storage.module";

@Module({
  imports: [HighlightsModule, StorageModule],
  controllers: [ClipsController],
  providers: [ClipsService],
})
export class ClipsModule {}
