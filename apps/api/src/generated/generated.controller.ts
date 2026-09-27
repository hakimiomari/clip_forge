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
import { GeneratedService } from "./generated.service";
import { CreateGeneratedVideoDto } from "./dto/generated.dto";
import {
  CurrentUser,
  RequestUser,
} from "../common/decorators/current-user.decorator";

@ApiTags("generated")
@Controller("generated")
export class GeneratedController {
  constructor(private readonly generated: GeneratedService) {}

  /** Which engine a new video would be made with, for the page to say so. */
  @Get("engine")
  engine() {
    return this.generated.engine();
  }

  @Post()
  create(@CurrentUser() user: RequestUser, @Body() dto: CreateGeneratedVideoDto) {
    return this.generated.create(user.id, dto);
  }

  @Get()
  list(@CurrentUser() user: RequestUser) {
    return this.generated.list(user.id);
  }

  @Get(":id")
  detail(@CurrentUser() user: RequestUser, @Param("id") id: string) {
    return this.generated.detail(id, user.id);
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(@CurrentUser() user: RequestUser, @Param("id") id: string) {
    await this.generated.remove(id, user.id);
  }
}
