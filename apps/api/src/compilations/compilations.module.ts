import { Module } from "@nestjs/common";
import { CompilationsController } from "./compilations.controller";
import { CompilationsService } from "./compilations.service";
import { StorageModule } from "../storage/storage.module";

@Module({
  imports: [StorageModule],
  controllers: [CompilationsController],
  providers: [CompilationsService],
})
export class CompilationsModule {}
