import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { HighlightsService } from "./highlights.service";
import { GenerateHighlightsDto } from "./dto/highlights.dto";
import {
  CurrentUser,
  RequestUser,
} from "../common/decorators/current-user.decorator";

@ApiTags("highlights")
@Controller()
export class HighlightsController {
  constructor(private readonly highlights: HighlightsService) {}

  @Post("projects/:id/highlights/generate")
  generate(
    @CurrentUser() user: RequestUser,
    @Param("id") projectId: string,
    @Body() dto: GenerateHighlightsDto,
  ) {
    return this.highlights.generate(projectId, user.id, dto);
  }

  @Get("projects/:id/highlights")
  list(@CurrentUser() user: RequestUser, @Param("id") projectId: string) {
    return this.highlights.list(projectId, user.id);
  }

  @Get("highlights/:id")
  get(@CurrentUser() user: RequestUser, @Param("id") id: string) {
    return this.highlights.getOwned(id, user.id);
  }
}
