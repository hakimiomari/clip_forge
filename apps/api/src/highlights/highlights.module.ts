import { Module } from "@nestjs/common";
import { HighlightsController } from "./highlights.controller";
import { HighlightsService } from "./highlights.service";
import { ProjectsModule } from "../projects/projects.module";

@Module({
  imports: [ProjectsModule],
  controllers: [HighlightsController],
  providers: [HighlightsService],
  exports: [HighlightsService],
})
export class HighlightsModule {}
