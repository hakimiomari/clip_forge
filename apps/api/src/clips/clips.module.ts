import { Module } from "@nestjs/common";
import { ClipsController } from "./clips.controller";
import { ClipsService } from "./clips.service";
import { HighlightsModule } from "../highlights/highlights.module";
import { ProjectsModule } from "../projects/projects.module";
import { StorageModule } from "../storage/storage.module";

@Module({
  imports: [HighlightsModule, ProjectsModule, StorageModule],
  controllers: [ClipsController],
  providers: [ClipsService],
})
export class ClipsModule {}
