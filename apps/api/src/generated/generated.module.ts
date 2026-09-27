import { Module } from "@nestjs/common";
import { GeneratedController } from "./generated.controller";
import { GeneratedService } from "./generated.service";
import { StorageModule } from "../storage/storage.module";

@Module({
  imports: [StorageModule],
  controllers: [GeneratedController],
  providers: [GeneratedService],
})
export class GeneratedModule {}
