import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { DownloadsService } from "./downloads.service";
import { CreateDownloadDto } from "./dto/download.dto";
import {
  CurrentUser,
  RequestUser,
} from "../common/decorators/current-user.decorator";

@ApiTags("downloads")
@Controller("downloads")
export class DownloadsController {
  constructor(private readonly downloads: DownloadsService) {}

  @Post()
  create(@CurrentUser() user: RequestUser, @Body() dto: CreateDownloadDto) {
    return this.downloads.create(user.id, dto);
  }

  @Get()
  list(@CurrentUser() user: RequestUser) {
    return this.downloads.list(user.id);
  }

  @Get(":id")
  detail(@CurrentUser() user: RequestUser, @Param("id") id: string) {
    return this.downloads.detail(id, user.id);
  }

  @Post(":id/retry")
  retry(@CurrentUser() user: RequestUser, @Param("id") id: string) {
    return this.downloads.retry(id, user.id);
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(@CurrentUser() user: RequestUser, @Param("id") id: string) {
    await this.downloads.remove(id, user.id);
  }
}
