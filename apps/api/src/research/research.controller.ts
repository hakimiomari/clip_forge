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
import { ResearchService } from "./research.service";
import { CreateResearchVideoDto } from "./dto/research.dto";
import {
  CurrentUser,
  RequestUser,
} from "../common/decorators/current-user.decorator";

@ApiTags("research")
@Controller("research")
export class ResearchController {
  constructor(private readonly research: ResearchService) {}

  @Post()
  create(@CurrentUser() user: RequestUser, @Body() dto: CreateResearchVideoDto) {
    return this.research.create(user.id, dto);
  }

  @Get()
  list(@CurrentUser() user: RequestUser) {
    return this.research.list(user.id);
  }

  @Get(":id")
  detail(@CurrentUser() user: RequestUser, @Param("id") id: string) {
    return this.research.detail(id, user.id);
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(@CurrentUser() user: RequestUser, @Param("id") id: string) {
    await this.research.remove(id, user.id);
  }
}
