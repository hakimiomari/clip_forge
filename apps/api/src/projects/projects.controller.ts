import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { ProjectsService } from "./projects.service";
import {
  CreateProjectDto,
  ImportSourceDto,
  ListProjectsQueryDto,
  UpdateProjectDto,
} from "./dto/project.dto";
import {
  CurrentUser,
  RequestUser,
} from "../common/decorators/current-user.decorator";

@ApiTags("projects")
@Controller("projects")
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Post()
  create(@CurrentUser() user: RequestUser, @Body() dto: CreateProjectDto) {
    return this.projects.create(user.id, dto);
  }

  @Get()
  list(
    @CurrentUser() user: RequestUser,
    @Query() query: ListProjectsQueryDto,
  ) {
    return this.projects.list(user.id, query);
  }

  @Get(":id")
  detail(@CurrentUser() user: RequestUser, @Param("id") id: string) {
    return this.projects.detail(id, user.id);
  }

  @Patch(":id")
  update(
    @CurrentUser() user: RequestUser,
    @Param("id") id: string,
    @Body() dto: UpdateProjectDto,
  ) {
    return this.projects.update(id, user.id, dto);
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(@CurrentUser() user: RequestUser, @Param("id") id: string) {
    await this.projects.remove(id, user.id);
  }

  @Post(":id/import")
  importSource(
    @CurrentUser() user: RequestUser,
    @Param("id") id: string,
    @Body() dto: ImportSourceDto,
  ) {
    return this.projects.importSource(id, user.id, dto);
  }

  @Get(":id/source")
  getSource(@CurrentUser() user: RequestUser, @Param("id") id: string) {
    return this.projects.getSource(id, user.id);
  }
}
