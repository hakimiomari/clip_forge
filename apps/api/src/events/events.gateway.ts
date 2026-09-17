import { Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import type { Server, Socket } from "socket.io";
import IORedis from "ioredis";
import type { ProjectProgressEvent } from "@clipforge/shared-types";
import { PrismaService } from "../prisma/prisma.service";

export const PROGRESS_CHANNEL = "clipforge:progress";

/**
 * Pushes pipeline progress to the browser. The worker publishes
 * ProjectProgressEvent JSON on a Redis channel; this gateway relays it
 * to the room of the owning project. Clients authenticate with their
 * access token and may only join rooms for projects they own.
 */
@WebSocketGateway({
  namespace: "/events",
  cors: { origin: process.env.WEB_ORIGIN ?? "http://localhost:3000", credentials: true },
})
export class EventsGateway implements OnModuleInit, OnModuleDestroy {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(EventsGateway.name);
  private subscriber?: IORedis;

  constructor(
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.subscriber = new IORedis(this.config.getOrThrow<string>("REDIS_URL"), {
      maxRetriesPerRequest: null,
    });
    void this.subscriber.subscribe(PROGRESS_CHANNEL);
    this.subscriber.on("message", (_channel: string, message: string) => {
      try {
        const event = JSON.parse(message) as ProjectProgressEvent;
        this.server
          .to(`project:${event.projectId}`)
          .emit("project:progress", event);
      } catch (err) {
        this.logger.warn(`Malformed progress event: ${String(err)}`);
      }
    });
  }

  onModuleDestroy(): void {
    this.subscriber?.disconnect();
  }

  @SubscribeMessage("subscribe:project")
  async subscribeProject(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { projectId: string },
  ): Promise<{ ok: boolean; error?: string }> {
    const userId = await this.authenticate(socket);
    if (!userId) return { ok: false, error: "unauthorized" };
    const project = await this.prisma.project.findUnique({
      where: { id: body.projectId },
      select: { userId: true },
    });
    if (!project || project.userId !== userId) {
      return { ok: false, error: "not_found" };
    }
    await socket.join(`project:${body.projectId}`);
    return { ok: true };
  }

  @SubscribeMessage("unsubscribe:project")
  async unsubscribeProject(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { projectId: string },
  ): Promise<{ ok: boolean }> {
    await socket.leave(`project:${body.projectId}`);
    return { ok: true };
  }

  /** Verifies the JWT passed in the socket handshake (auth.token) or cookie. */
  private async authenticate(socket: Socket): Promise<string | null> {
    try {
      let token = socket.handshake.auth?.token as string | undefined;
      if (!token) {
        const cookies = socket.handshake.headers.cookie ?? "";
        const match = cookies.match(/(?:^|;\s*)cf_access=([^;]+)/);
        token = match?.[1];
      }
      if (!token) return null;
      const payload = await this.jwt.verifyAsync<{ sub: string }>(token, {
        secret: this.config.getOrThrow<string>("JWT_SECRET"),
      });
      return payload.sub;
    } catch {
      return null;
    }
  }
}
