import { Body, Controller, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { StorageService } from "./storage.service";
import { PresignUploadDto } from "./dto/uploads.dto";
import {
  CurrentUser,
  RequestUser,
} from "../common/decorators/current-user.decorator";

@ApiTags("uploads")
@Controller("uploads")
export class UploadsController {
  constructor(private readonly storage: StorageService) {}

  @Post("presign")
  presign(@CurrentUser() user: RequestUser, @Body() dto: PresignUploadDto) {
    return this.storage.presignUpload(user.id, dto.fileName, dto.contentType);
  }
}
