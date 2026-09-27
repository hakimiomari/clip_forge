import { createWriteStream } from "fs";
import { stat, unlink } from "fs/promises";
import { pipeline } from "stream/promises";
import type { Readable } from "stream";
import type { GeneratedEngine, GeneratedFormat } from "@clipforge/shared-types";
import { env } from "../../env";
import { GENERATED_SIZES, generateSceneImage } from "../research/images";

/**
 * One engine call = one shot. Every engine takes the same request and
 * leaves a file at `outPath`: a video from Veo or Sora, a picture from
 * the free engine (the renderer gives pictures their motion).
 *
 * Plain fetch throughout, no SDKs: the two hosted APIs are a start
 * request, a poll loop and a download.
 */

export interface ShotRequest {
  prompt: string;
  seconds: number;
  format: GeneratedFormat;
  outPath: string;
  /** Fixed per shot so a retry of the same video looks the same */
  seed: number;
}

export interface ShotResult {
  isVideo: boolean;
  model: string;
}

const POLL_INTERVAL_MS = 10_000;
/** A hosted model can queue for minutes; past this it is stuck, not slow. */
const MAX_WAIT_MS = 12 * 60_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The allowed length closest to what was asked. */
function nearest(allowed: number[], seconds: number): number {
  return allowed.reduce((best, value) =>
    Math.abs(value - seconds) < Math.abs(best - seconds) ? value : best,
  );
}

async function readError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    return parsed.error?.message ?? text;
  } catch {
    return text;
  }
}

async function saveResponse(response: Response, outPath: string): Promise<void> {
  if (!response.ok || !response.body) {
    throw new Error(`download failed (HTTP ${response.status})`);
  }
  await pipeline(response.body as unknown as Readable, createWriteStream(outPath));
  const { size } = await stat(outPath);
  if (size < 10_000) {
    await unlink(outPath).catch(() => undefined);
    throw new Error(`downloaded file too small (${size} bytes)`);
  }
}

/** Google Veo through the Gemini API: start a long-running job, poll it, fetch the file. */
export async function veoShot(req: ShotRequest): Promise<ShotResult> {
  const key = env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  const model = env.VEO_MODEL;
  const base = "https://generativelanguage.googleapis.com/v1beta";

  const start = await fetch(`${base}/models/${model}:predictLongRunning`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({
      instances: [{ prompt: req.prompt }],
      parameters: {
        aspectRatio: req.format === "landscape" ? "16:9" : "9:16",
        durationSeconds: String(nearest([4, 6, 8], req.seconds)),
        resolution: "720p",
      },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!start.ok) {
    throw new Error(
      `Veo refused the request (HTTP ${start.status}): ${(await readError(start)).slice(0, 300)}`,
    );
  }
  const { name } = (await start.json()) as { name?: string };
  if (!name) throw new Error("Veo returned no operation to wait for");

  const deadline = Date.now() + MAX_WAIT_MS;
  for (;;) {
    await sleep(POLL_INTERVAL_MS);
    const poll = await fetch(`${base}/${name}`, {
      headers: { "x-goog-api-key": key },
      signal: AbortSignal.timeout(60_000),
    });
    if (!poll.ok) {
      throw new Error(
        `Veo status check failed (HTTP ${poll.status}): ${(await readError(poll)).slice(0, 300)}`,
      );
    }
    const op = (await poll.json()) as {
      done?: boolean;
      error?: { message?: string };
      response?: {
        generateVideoResponse?: {
          generatedSamples?: Array<{ video?: { uri?: string } }>;
          raiMediaFilteredReasons?: string[];
        };
      };
    };
    if (op.error) throw new Error(`Veo failed: ${op.error.message ?? "unknown error"}`);
    if (op.done) {
      const result = op.response?.generateVideoResponse;
      const uri = result?.generatedSamples?.[0]?.video?.uri;
      if (!uri) {
        const why = result?.raiMediaFilteredReasons?.join("; ");
        throw new Error(why ? `Veo declined this prompt: ${why}` : "Veo returned no video");
      }
      const file = await fetch(uri, {
        headers: { "x-goog-api-key": key },
        redirect: "follow",
        signal: AbortSignal.timeout(5 * 60_000),
      });
      await saveResponse(file, req.outPath);
      return { isVideo: true, model };
    }
    if (Date.now() > deadline) throw new Error("Veo took longer than 12 minutes");
  }
}

/** OpenAI Sora: create a video job, poll it, fetch the content. */
export async function soraShot(req: ShotRequest): Promise<ShotResult> {
  const key = env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set");
  const model = env.SORA_MODEL;
  const base = "https://api.openai.com/v1/videos";
  const auth = { authorization: `Bearer ${key}` };

  const create = await fetch(base, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      prompt: req.prompt,
      size: req.format === "landscape" ? "1280x720" : "720x1280",
      seconds: String(nearest([4, 8, 12], req.seconds)),
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!create.ok) {
    throw new Error(
      `Sora refused the request (HTTP ${create.status}): ${(await readError(create)).slice(0, 300)}`,
    );
  }
  const job = (await create.json()) as { id?: string };
  if (!job.id) throw new Error("Sora returned no job to wait for");

  const deadline = Date.now() + MAX_WAIT_MS;
  for (;;) {
    await sleep(POLL_INTERVAL_MS);
    const poll = await fetch(`${base}/${job.id}`, {
      headers: auth,
      signal: AbortSignal.timeout(60_000),
    });
    if (!poll.ok) {
      throw new Error(
        `Sora status check failed (HTTP ${poll.status}): ${(await readError(poll)).slice(0, 300)}`,
      );
    }
    const status = (await poll.json()) as {
      status?: string;
      error?: { message?: string };
    };
    if (status.status === "failed") {
      throw new Error(`Sora failed: ${status.error?.message ?? "unknown error"}`);
    }
    if (status.status === "completed") {
      const file = await fetch(`${base}/${job.id}/content`, {
        headers: auth,
        redirect: "follow",
        signal: AbortSignal.timeout(5 * 60_000),
      });
      await saveResponse(file, req.outPath);
      return { isVideo: true, model };
    }
    if (Date.now() > deadline) throw new Error("Sora took longer than 12 minutes");
  }
}

/** The free engine: a generated picture; the renderer adds the camera motion. */
export async function imageShot(req: ShotRequest): Promise<ShotResult> {
  const { width, height } = GENERATED_SIZES[req.format];
  const drawn = await generateSceneImage({
    prompt: req.prompt,
    outPath: req.outPath,
    width,
    height,
    seed: req.seed,
  });
  if (!drawn) {
    throw new Error(
      "The free image engine could not draw this shot — it may be busy; try again in a minute",
    );
  }
  return { isVideo: false, model: "pollinations/flux" };
}

export function generateShot(engine: GeneratedEngine, req: ShotRequest): Promise<ShotResult> {
  switch (engine) {
    case "veo":
      return veoShot(req);
    case "sora":
      return soraShot(req);
    default:
      return imageShot(req);
  }
}
