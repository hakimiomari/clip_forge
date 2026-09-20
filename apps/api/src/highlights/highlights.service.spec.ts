import { BadRequestException } from "@nestjs/common";
import { HighlightsService } from "./highlights.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { ProjectsService } from "../projects/projects.service";
import type { QueuesService } from "../queues/queues.service";
import type { UsageService } from "../usage/usage.service";
import type { GenerateHighlightsDto } from "./dto/highlights.dto";

const OWNER = "user_1";

function makeService(sourceOverrides?: Record<string, unknown>) {
  const prisma = {
    videoSource: {
      findUnique: jest.fn().mockResolvedValue({
        projectId: "p1",
        sourceType: "UPLOAD",
        storageKey: "users/u1/uploads/x.mp4",
        externalId: null,
        duration: 600,
        ...sourceOverrides,
      }),
    },
    project: { update: jest.fn().mockResolvedValue({}) },
  } as unknown as PrismaService;

  const projects = {
    getOwned: jest.fn().mockResolvedValue({ id: "p1", userId: OWNER, status: "IMPORTED" }),
  } as unknown as ProjectsService;

  const queues = {
    enqueueHighlightGeneration: jest.fn().mockResolvedValue("job1"),
  } as unknown as QueuesService;

  const usage = {
    spend: jest.fn().mockResolvedValue(undefined),
    refund: jest.fn().mockResolvedValue(undefined),
  } as unknown as UsageService;

  return {
    service: new HighlightsService(prisma, projects, queues, usage),
    queues,
    usage,
  };
}

const dto = (overrides: Partial<GenerateHighlightsDto> = {}) =>
  ({
    clipDuration: 30,
    clipCount: 3,
    format: "vertical",
    editingStyle: "dynamic_viral",
    captionStyle: "bold_dynamic",
    useTranscript: true,
    autoCreateClips: false,
    captionsEnabled: true,
    zoomEnabled: true,
    backgroundMode: "blur",
    ctaEnabled: true,
    ...overrides,
  }) as GenerateHighlightsDto;

describe("HighlightsService.generate", () => {
  it("charges only the search fee when suggesting moments", async () => {
    const { service, usage } = makeService();
    await service.generate("p1", OWNER, dto());
    expect(usage.spend).toHaveBeenCalledWith(OWNER, 2, "GENERATE_HIGHLIGHTS", {
      projectId: "p1",
    });
  });

  it("pre-pays for every short in automatic mode", async () => {
    const { service, usage, queues } = makeService();
    const result = await service.generate(
      "p1",
      OWNER,
      dto({ autoCreateClips: true, clipCount: 3, clipDuration: 60 }),
    );
    // 2 to find the moments + 3 shorts x 4 credits for 60s
    expect(usage.spend).toHaveBeenCalledWith(OWNER, 14, "GENERATE_HIGHLIGHTS", {
      projectId: "p1",
    });
    expect(result).toMatchObject({ autoCreateClips: true, creditsCharged: 14 });
    // The worker needs the per-short price to refund any it can't produce
    expect(queues.enqueueHighlightGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        chargedCredits: 14,
        options: expect.objectContaining({
          autoCreateClips: true,
          autoRenderCreditsPerClip: 4,
        }),
      }),
    );
  });

  it("refunds everything when the job cannot be queued", async () => {
    const { service, usage, queues } = makeService();
    (queues.enqueueHighlightGeneration as jest.Mock).mockRejectedValueOnce(
      new Error("redis down"),
    );
    await expect(
      service.generate("p1", OWNER, dto({ autoCreateClips: true, clipCount: 5, clipDuration: 30 })),
    ).rejects.toThrow("redis down");
    // 2 + 5 x 2 — the whole pre-payment comes back
    expect(usage.refund).toHaveBeenCalledWith(OWNER, 12, { projectId: "p1" });
  });

  it("rejects a clip length longer than the video", async () => {
    const { service, usage } = makeService({ duration: 20 });
    await expect(service.generate("p1", OWNER, dto({ clipDuration: 60 }))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(usage.spend).not.toHaveBeenCalled();
  });
});
