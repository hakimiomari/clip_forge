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
import { PhotosService } from "./photos.service";
import { CreatePhotoSetDto } from "./dto/photos.dto";
import {
  CurrentUser,
  RequestUser,
} from "../common/decorators/current-user.decorator";

@ApiTags("photos")
@Controller("photos")
export class PhotosController {
  constructor(private readonly photos: PhotosService) {}

  @Post()
  create(@CurrentUser() user: RequestUser, @Body() dto: CreatePhotoSetDto) {
    return this.photos.create(user.id, dto);
  }

  @Get()
  list(@CurrentUser() user: RequestUser) {
    return this.photos.list(user.id);
  }

  @Get(":id")
  detail(@CurrentUser() user: RequestUser, @Param("id") id: string) {
    return this.photos.detail(id, user.id);
  }

  @Post(":id/retry")
  retry(@CurrentUser() user: RequestUser, @Param("id") id: string) {
    return this.photos.retry(id, user.id);
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(@CurrentUser() user: RequestUser, @Param("id") id: string) {
    await this.photos.remove(id, user.id);
  }
}
