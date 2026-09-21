import { Module } from "@nestjs/common";
import { ResearchController } from "./research.controller";
import { ResearchService } from "./research.service";
import { StorageModule } from "../storage/storage.module";

@Module({
  imports: [StorageModule],
  controllers: [ResearchController],
  providers: [ResearchService],
})
export class ResearchModule {}
