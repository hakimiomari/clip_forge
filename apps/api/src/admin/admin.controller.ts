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
  UseGuards,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { AdminService } from "./admin.service";
import {
  AdminAdjustCreditsDto,
  AdminListUsersQueryDto,
  AdminUpdateUserDto,
} from "./dto/admin.dto";
import { AdminGuard } from "../common/guards/admin.guard";
import {
  CurrentUser,
  RequestUser,
} from "../common/decorators/current-user.decorator";

@ApiTags("admin")
@UseGuards(AdminGuard)
@Controller("admin")
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get("stats")
  stats() {
    return this.admin.stats();
  }

  @Get("users")
  listUsers(@Query() query: AdminListUsersQueryDto) {
    return this.admin.listUsers(query);
  }

  @Patch("users/:id")
  updateUser(
    @CurrentUser() user: RequestUser,
    @Param("id") id: string,
    @Body() dto: AdminUpdateUserDto,
  ) {
    return this.admin.updateUser(user.id, id, dto);
  }

  @Post("users/:id/credits")
  adjustCredits(@Param("id") id: string, @Body() dto: AdminAdjustCreditsDto) {
    return this.admin.adjustCredits(id, dto);
  }

  @Get("jobs")
  listJobs() {
    return this.admin.listJobs();
  }

  @Post("render-jobs/:id/retry")
  retryRenderJob(@Param("id") id: string) {
    return this.admin.retryRenderJob(id);
  }

  @Delete("projects/:id")
  @HttpCode(204)
  async deleteProject(@Param("id") id: string) {
    await this.admin.deleteProject(id);
  }
}
