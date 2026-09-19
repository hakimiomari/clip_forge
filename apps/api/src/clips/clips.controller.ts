import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { ClipsService } from "./clips.service";
import { CreateClipDto, UpdateClipDto } from "./dto/clips.dto";
import {
  CurrentUser,
  RequestUser,
} from "../common/decorators/current-user.decorator";

@ApiTags("clips")
@Controller()
export class ClipsController {
  constructor(private readonly clips: ClipsService) {}

  @Post("highlights/:id/create-clip")
  createFromHighlight(
    @CurrentUser() user: RequestUser,
    @Param("id") highlightId: string,
    @Body() dto: CreateClipDto,
  ) {
    return this.clips.createFromHighlight(highlightId, user.id, dto);
  }

  @Get("clips/:id")
  detail(@CurrentUser() user: RequestUser, @Param("id") id: string) {
    return this.clips.detail(id, user.id);
  }

  @Patch("clips/:id")
  update(
    @CurrentUser() user: RequestUser,
    @Param("id") id: string,
    @Body() dto: UpdateClipDto,
  ) {
    return this.clips.update(id, user.id, dto);
  }

  @Post("clips/:id/render")
  render(@CurrentUser() user: RequestUser, @Param("id") id: string) {
    return this.clips.render(id, user.id);
  }

  @Get("clips/:id/render-status")
  async renderStatus(@CurrentUser() user: RequestUser, @Param("id") id: string) {
    const detail = await this.clips.detail(id, user.id);
    return { status: detail.status, renderJob: detail.renderJob };
  }

  @Get("clips/:id/download")
  download(@CurrentUser() user: RequestUser, @Param("id") id: string) {
    return this.clips.download(id, user.id);
  }

  @Get("projects/:id/exports")
  listExports(@CurrentUser() user: RequestUser, @Param("id") projectId: string) {
    return this.clips.listExports(projectId, user.id);
  }

  @Delete("clips/:id")
  @HttpCode(204)
  async remove(@CurrentUser() user: RequestUser, @Param("id") id: string) {
    await this.clips.remove(id, user.id);
  }
}
