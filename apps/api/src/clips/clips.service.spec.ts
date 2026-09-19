import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ClipsService } from "./clips.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { QueuesService } from "../queues/queues.service";
import type { StorageService } from "../storage/storage.service";
import type { UsageService } from "../usage/usage.service";
import type { HighlightsService } from "../highlights/highlights.service";

const OWNER = "user_1";

function makeService(clipOverrides?: Record<string, unknown>) {
  const clip = {
    id: "c1",
    projectId: "p1",
    highlightId: "h1",
    status: "DRAFT",
    renderedKey: null,
    previewKey: null,
    name: "Clip",
    format: "vertical",
    resolution: "1080x1920",
    duration: 60,
    createdAt: new Date("2026-09-19T00:00:00Z"),
    updatedAt: new Date("2026-09-19T00:00:00Z"),
    editingPlan: {
      version: 1,
      duration: 60,
      format: "vertical",
      resolution: "1080x1920",
      template: "auto_v1",
      segments: [
        { sourceStart: 30, sourceEnd: 90, crop: { mode: "center" }, effects: [] },
      ],
      captions: {
        enabled: true,
        style: "bold_dynamic",
        position: "center",
        highlightKeywords: false,
        animation: "sentence",
      },
      transitions: [],
      audio: {
        originalVolume: 1,
        backgroundMusic: false,
        musicVolume: 0,
        fadeIn: true,
        fadeOut: true,
      },
    },
    project: { id: "p1", userId: OWNER },
    ...clipOverrides,
  };

  const prisma = {
    clip: {
      findUnique: jest.fn().mockResolvedValue(clip),
      update: jest.fn().mockResolvedValue(clip),
    },
    renderJob: {
      create: jest.fn().mockResolvedValue({ id: "rj1" }),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    export: { findFirst: jest.fn().mockResolvedValue(null) },
  } as unknown as PrismaService;

  const queues = {
    enqueueRenderVideo: jest.fn().mockResolvedValue("job1"),
    enqueueCleanup: jest.fn(),
  } as unknown as QueuesService;

  const storage = {
    presignGet: jest.fn().mockResolvedValue("https://signed"),
  } as unknown as StorageService;

  const usage = {
    spend: jest.fn().mockResolvedValue(undefined),
    refund: jest.fn().mockResolvedValue(undefined),
  } as unknown as UsageService;

  const highlights = {} as HighlightsService;

  return {
    service: new ClipsService(prisma, queues, storage, usage, highlights),
    prisma,
    queues,
    usage,
  };
}

describe("ClipsService", () => {
  it("denies access to another user's clip", async () => {
    const { service } = makeService();
    await expect(service.getOwned("c1", "stranger")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("charges duration-based credits and enqueues the render", async () => {
    const { service, usage, queues } = makeService();
    await service.render("c1", OWNER);
    // 60s clip → ceil(60/30)*2 = 4 credits
    expect(usage.spend).toHaveBeenCalledWith(OWNER, 4, "RENDER_CLIP", {
      projectId: "p1",
      clipId: "c1",
    });
    expect(queues.enqueueRenderVideo).toHaveBeenCalledWith({
      clipId: "c1",
      renderJobId: "rj1",
      userId: OWNER,
    });
  });

  it("rejects rendering a clip that is already rendering", async () => {
    const { service } = makeService({ status: "RENDERING" });
    await expect(service.render("c1", OWNER)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("rejects rendering without an editing plan", async () => {
    const { service } = makeService({ editingPlan: null });
    await expect(service.render("c1", OWNER)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
