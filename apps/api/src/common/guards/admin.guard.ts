import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import type { RequestUser } from "../decorators/current-user.decorator";

/** Restricts a route to ADMIN users. Apply after the global JWT guard. */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user = request.user as RequestUser | undefined;
    if (user?.role !== "ADMIN") {
      throw new ForbiddenException("Admin access required");
    }
    return true;
  }
}
