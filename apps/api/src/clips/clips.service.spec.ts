import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ClipsService } from "./clips.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { QueuesService } from "../queues/queues.service";
import type { StorageService } from "../storage/storage.service";
import type { UsageService } from "../usage/usage.service";
import type { HighlightsService } from "../highlights/highlights.service";
import type { ProjectsService } from "../projects/projects.service";
import type { CreateClipFromRangeDto } from "./dto/clips.dto";

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
      create: jest.fn().mockResolvedValue(clip),
    },
    renderJob: {
      create: jest.fn().mockResolvedValue({ id: "rj1" }),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    export: { findFirst: jest.fn().mockResolvedValue(null) },
    videoSource: { findUnique: jest.fn().mockResolvedValue(null) },
    project: {
      findUnique: jest.fn().mockResolvedValue({ sourceUrl: "https://youtu.be/abc" }),
    },
    transcript: { findUnique: jest.fn().mockResolvedValue(null) },
    caption: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      count: jest.fn().mockResolvedValue(0),
    },
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

  const projects = {
    getOwned: jest.fn().mockResolvedValue({ id: "p1", userId: "u1" }),
  } as unknown as ProjectsService;

  return {
    service: new ClipsService(prisma, queues, storage, usage, highlights, projects),
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
      chargedCredits: 4,
    });
  });

  it("picks up captions that arrived after the clip was created", async () => {
    const { service, prisma } = makeService();
    (prisma.transcript.findUnique as jest.Mock).mockResolvedValue({
      id: "t1",
      segments: [
        { startTime: 35, endTime: 38, text: "a line inside the clip", speaker: null },
      ],
    });
    await service.render("c1", OWNER);
    // The clip window is 30–90, so the line lands 5s in
    expect(prisma.caption.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ clipId: "c1", startTime: 5, endTime: 8 }),
      ],
    });
  });

  it("leaves existing captions alone on a re-render", async () => {
    const { service, prisma } = makeService();
    (prisma.caption.count as jest.Mock).mockResolvedValue(4);
    await service.render("c1", OWNER);
    expect(prisma.caption.deleteMany).not.toHaveBeenCalled();
    expect(prisma.caption.createMany).not.toHaveBeenCalled();
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

describe("ClipsService.createFromRange", () => {
  const range = (sourceStart: number, sourceEnd: number) =>
    ({
      sourceStart,
      sourceEnd,
      format: "vertical",
      captionsEnabled: true,
      captionStyle: "bold_dynamic",
      zoomEnabled: true,
      ctaEnabled: true,
      backgroundMode: "blur",
    }) as unknown as CreateClipFromRangeDto;

  /** A 100s source by default, so ranges near the end can be exercised. */
  function makeRangeService(duration = 100) {
    const made = makeService();
    (made.prisma.videoSource.findUnique as jest.Mock).mockResolvedValue({
      projectId: "p1",
      sourceType: "UPLOAD",
      storageKey: "users/u1/uploads/x.mp4",
      externalId: null,
      duration,
    });
    return made;
  }

  it("rejects a selection shorter than the minimum instead of widening it", async () => {
    const { service, prisma } = makeRangeService();
    await expect(service.createFromRange("p1", OWNER, range(3, 5))).rejects.toThrow(
      /at least 5 seconds/,
    );
    expect(prisma.clip.create).not.toHaveBeenCalled();
  });

  it("rejects a selection running past the end of the source", async () => {
    const { service } = makeRangeService();
    await expect(
      service.createFromRange("p1", OWNER, range(98.5, 130)),
    ).rejects.toThrow(/ends at 130.0s but the video is only 100.0s long/);
  });

  it("tolerates a rounding overshoot on the final frame", async () => {
    const { service, prisma } = makeRangeService();
    await service.createFromRange("p1", OWNER, range(80, 100.2));
    const created = (prisma.clip.create as jest.Mock).mock.calls[0][0].data;
    expect(created.editingPlan.segments[0].sourceEnd).toBe(100);
  });

  it("rejects a part that is left too short to use", async () => {
    const { service } = makeRangeService();
    await expect(
      service.createFromRange("p1", OWNER, {
        ...range(0, 0),
        segments: [
          { sourceStart: 10, sourceEnd: 16 },
          { sourceStart: 99.9, sourceEnd: 100 },
        ],
      } as unknown as CreateClipFromRangeDto),
    ).rejects.toThrow(/Part 2 is too short/);
  });

  it("rejects an inverted selection", async () => {
    const { service } = makeRangeService();
    await expect(service.createFromRange("p1", OWNER, range(40, 10))).rejects.toThrow(
      /must end after it starts/,
    );
  });

  it("rejects a selection longer than the maximum", async () => {
    const { service } = makeRangeService();
    // Source long enough that 300s is in range but over the clip cap
    const { service: longService } = makeRangeService(600);
    await expect(
      longService.createFromRange("p1", OWNER, range(0, 300)),
    ).rejects.toThrow(/limited to 240 seconds/);
    // …and on a short source the same request is refused as out of range
    await expect(service.createFromRange("p1", OWNER, range(0, 300))).rejects.toThrow(
      /the video is only 100.0s long/,
    );
  });

  it("stitches several parts into one plan, in order", async () => {
    const { service, prisma } = makeRangeService();
    await service.createFromRange("p1", OWNER, {
      ...range(0, 0),
      segments: [
        { sourceStart: 30, sourceEnd: 34 },
        { sourceStart: 5, sourceEnd: 8 },
      ],
    } as unknown as CreateClipFromRangeDto);
    const created = (prisma.clip.create as jest.Mock).mock.calls[0][0].data;
    expect(created.editingPlan.segments).toMatchObject([
      { sourceStart: 30, sourceEnd: 34 },
      { sourceStart: 5, sourceEnd: 8 },
    ]);
    // Billed and stored on the total, not the first part
    expect(created.duration).toBeCloseTo(7);
    expect(created.editingPlan.duration).toBeCloseTo(7);
  });

  it("rejects parts that add up to less than the minimum", async () => {
    const { service } = makeRangeService();
    await expect(
      service.createFromRange("p1", OWNER, {
        ...range(0, 0),
        segments: [
          { sourceStart: 10, sourceEnd: 11 },
          { sourceStart: 20, sourceEnd: 21 },
        ],
      } as unknown as CreateClipFromRangeDto),
    ).rejects.toThrow(/at least 5 seconds of video in total/);
  });

  it("names the offending part when one is invalid", async () => {
    const { service } = makeRangeService();
    await expect(
      service.createFromRange("p1", OWNER, {
        ...range(0, 0),
        segments: [
          { sourceStart: 10, sourceEnd: 16 },
          { sourceStart: 40, sourceEnd: 30 },
        ],
      } as unknown as CreateClipFromRangeDto),
    ).rejects.toThrow(/Part 2 must end after it starts/);
  });

  it("requires either a range or parts", async () => {
    const { service } = makeRangeService();
    await expect(
      service.createFromRange("p1", OWNER, {
        format: "vertical",
        captionsEnabled: true,
        captionStyle: "bold_dynamic",
        zoomEnabled: true,
      } as unknown as CreateClipFromRangeDto),
    ).rejects.toThrow(/sourceStart and sourceEnd, or a segments array/);
  });

  it("writes a postable title and description from real clip data", async () => {
    const { service, prisma } = makeRangeService();
    (prisma.videoSource.findUnique as jest.Mock).mockResolvedValue({
      projectId: "p1",
      sourceType: "YOUTUBE",
      storageKey: null,
      externalId: "abc",
      duration: 100,
      title: "Afghanistan vs India | T20I Series",
    });
    (prisma.transcript.findUnique as jest.Mock).mockResolvedValue({
      id: "t1",
      segments: [{ startTime: 31, endTime: 34, text: "what a shot", speaker: null }],
    });

    await service.createFromRange("p1", OWNER, range(30, 40));
    const created = (prisma.clip.create as jest.Mock).mock.calls[0][0].data;
    // Title comes from what is actually said, not from a model
    expect(created.name).toBe("what a shot");
    expect(created.description).toContain('"what a shot"');
    expect(created.description).toContain("From: Afghanistan vs India | T20I Series");
    expect(created.description).toContain("Moment: 0:30–0:40");
    expect(created.description).toContain("https://youtu.be/abc");
  });

  it("keeps the exact selected window on the editing plan", async () => {
    const { service, prisma } = makeRangeService();
    await service.createFromRange("p1", OWNER, range(12.4, 42.9));
    const created = (prisma.clip.create as jest.Mock).mock.calls[0][0].data;
    expect(created.editingPlan.segments[0]).toMatchObject({
      sourceStart: 12.4,
      sourceEnd: 42.9,
    });
    // Manual clips are not tied to an AI suggestion
    expect(created.highlightId).toBeUndefined();
  });
});
