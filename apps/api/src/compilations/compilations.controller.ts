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
import { CompilationsService } from "./compilations.service";
import { CreateCompilationDto } from "./dto/compilation.dto";
import {
  CurrentUser,
  RequestUser,
} from "../common/decorators/current-user.decorator";

@ApiTags("compilations")
@Controller("compilations")
export class CompilationsController {
  constructor(private readonly compilations: CompilationsService) {}

  @Post()
  create(@CurrentUser() user: RequestUser, @Body() dto: CreateCompilationDto) {
    return this.compilations.create(user.id, dto);
  }

  @Get()
  list(@CurrentUser() user: RequestUser) {
    return this.compilations.list(user.id);
  }

  @Get(":id")
  detail(@CurrentUser() user: RequestUser, @Param("id") id: string) {
    return this.compilations.detail(id, user.id);
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(@CurrentUser() user: RequestUser, @Param("id") id: string) {
    await this.compilations.remove(id, user.id);
  }
}
