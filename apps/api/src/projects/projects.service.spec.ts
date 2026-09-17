import { NotFoundException, ForbiddenException, BadRequestException } from "@nestjs/common";
import { ProjectsService, extractYouTubeId } from "./projects.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { QueuesService } from "../queues/queues.service";
import type { StorageService } from "../storage/storage.service";
import type { UsageService } from "../usage/usage.service";
import { ImportRights, ImportSourceType } from "./dto/project.dto";

describe("extractYouTubeId", () => {
  it("parses watch URLs", () => {
    expect(extractYouTubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ",
    );
  });

  it("parses short youtu.be URLs", () => {
    expect(extractYouTubeId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("parses shorts URLs", () => {
    expect(extractYouTubeId("https://www.youtube.com/shorts/abc123XYZ_-")).toBe(
      "abc123XYZ_-",
    );
  });

  it("rejects non-YouTube URLs", () => {
    expect(extractYouTubeId("https://example.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(extractYouTubeId("not a url")).toBeNull();
  });
});

describe("ProjectsService ownership & import", () => {
  const owner = "user_1";
  const stranger = "user_2";

  function makeService(overrides?: {
    project?: Record<string, unknown> | null;
  }) {
    const project =
      overrides?.project === undefined
        ? { id: "p1", userId: owner, status: "DRAFT" }
        : overrides.project;

    const prisma = {
      project: {
        findUnique: jest.fn().mockResolvedValue(project),
        update: jest.fn().mockResolvedValue({ id: "p1", status: "IMPORTING" }),
      },
      videoSource: {
        upsert: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      $transaction: jest.fn().mockResolvedValue([{}, { id: "p1", status: "IMPORTING" }]),
    } as unknown as PrismaService;

    const queues = {
      enqueueVideoImport: jest.fn().mockResolvedValue("job_1"),
      enqueueCleanup: jest.fn(),
    } as unknown as QueuesService;

    const storage = {
      presignGet: jest.fn().mockResolvedValue("https://signed"),
    } as unknown as StorageService;

    const usage = {
      spend: jest.fn().mockResolvedValue(undefined),
      refund: jest.fn().mockResolvedValue(undefined),
    } as unknown as UsageService;

    return {
      service: new ProjectsService(prisma, queues, storage, usage),
      prisma,
      queues,
      usage,
    };
  }

  it("denies access to another user's project (as not-found)", async () => {
    const { service } = makeService();
    await expect(service.getOwned("p1", stranger)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("returns the project to its owner", async () => {
    const { service } = makeService();
    await expect(service.getOwned("p1", owner)).resolves.toMatchObject({
      id: "p1",
    });
  });

  it("rejects upload imports that reference another user's storage prefix", async () => {
    const { service } = makeService();
    await expect(
      service.importSource("p1", owner, {
        sourceType: ImportSourceType.UPLOAD,
        storageKey: `users/${stranger}/uploads/x/video.mp4`,
        rights: ImportRights.OWNED,
        rightsConfirmed: true,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("rejects import when project already has a source", async () => {
    const { service } = makeService({
      project: { id: "p1", userId: owner, status: "IMPORTED" },
    });
    await expect(
      service.importSource("p1", owner, {
        sourceType: ImportSourceType.YOUTUBE,
        url: "https://youtu.be/dQw4w9WgXcQ",
        rights: ImportRights.OWNED,
        rightsConfirmed: true,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("spends a credit and enqueues the import job for a valid upload", async () => {
    const { service, queues, usage } = makeService();
    await service.importSource("p1", owner, {
      sourceType: ImportSourceType.UPLOAD,
      storageKey: `users/${owner}/uploads/x/video.mp4`,
      rights: ImportRights.OWNED,
      rightsConfirmed: true,
    });
    expect(usage.spend).toHaveBeenCalledWith(owner, 1, "IMPORT_VIDEO", {
      projectId: "p1",
    });
    expect(queues.enqueueVideoImport).toHaveBeenCalledWith({
      projectId: "p1",
      userId: owner,
    });
  });
});
