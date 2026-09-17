import { ValidationPipe, Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const logger = new Logger("Bootstrap");

  const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:3000";

  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({
    origin: webOrigin,
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.enableShutdownHooks();

  const swaggerConfig = new DocumentBuilder()
    .setTitle("ClipForge AI API")
    .setDescription("AI-powered video highlight generator & short-form video editor")
    .setVersion("0.1.0")
    .addBearerAuth()
    .addCookieAuth("cf_access")
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup("docs", app, document);

  const port = Number(process.env.API_PORT ?? 4000);
  await app.listen(port);
  logger.log(`API listening on http://localhost:${port} (docs at /docs)`);
}

void bootstrap();
