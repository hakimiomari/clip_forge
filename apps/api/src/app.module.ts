import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ConfigModule } from "@nestjs/config";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { validateEnv } from "./config/env.validation";
import { PrismaModule } from "./prisma/prisma.module";
import { AuthModule } from "./auth/auth.module";
import { UsersModule } from "./users/users.module";
import { ProjectsModule } from "./projects/projects.module";
import { StorageModule } from "./storage/storage.module";
import { QueuesModule } from "./queues/queues.module";
import { UsageModule } from "./usage/usage.module";
import { EventsModule } from "./events/events.module";
import { HealthModule } from "./health/health.module";
import { DashboardModule } from "./dashboard/dashboard.module";
import { JwtAuthGuard } from "./common/guards/jwt-auth.guard";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Load repo-root .env so all apps share one file in development
      envFilePath: [".env", "../../.env"],
      validate: validateEnv,
    }),
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60_000, limit: 120 }],
      // Rate limiting applies to HTTP only; the WS gateway does its own auth
      skipIf: (context) => context.getType() !== "http",
    }),
    PrismaModule,
    AuthModule,
    UsersModule,
    ProjectsModule,
    StorageModule,
    QueuesModule,
    UsageModule,
    EventsModule,
    DashboardModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
