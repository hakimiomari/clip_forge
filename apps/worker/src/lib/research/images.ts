import { createWriteStream } from "fs";
import { stat, unlink } from "fs/promises";
import { pipeline } from "stream/promises";
import type { Readable } from "stream";
import type { ResearchFormat } from "@clipforge/shared-types";

/**
 * Drawn scenes: instead of a photograph from Commons, each scene's
 * picture is generated from its own sentence.
 *
 * Pollinations serves a free, keyless image endpoint, so this works
 * without an account — but the prompt does leave the machine, and the
 * pictures are invented rather than evidence of anything. Callers label
 * the result as illustration.
 */

const ENDPOINT = "https://image.pollinations.ai/prompt";
const USER_AGENT = "ClipForge/0.1 (research video builder)";
/** Generation is slower than a download, and a cold model slower still. */
const TIMEOUT_MS = 120_000;

/** Generated size per format — modest, since the frame rescales anyway. */
export const GENERATED_SIZES: Record<ResearchFormat, { width: number; height: number }> = {
  vertical: { width: 768, height: 1344 },
  square: { width: 1024, height: 1024 },
  landscape: { width: 1344, height: 768 },
};

/** Look applied to every generated scene, so the video holds together. */
const STYLE_SUFFIX =
  "anime illustration, studio ghibli style, hand painted, soft lighting, " +
  "detailed background, cinematic composition, no text, no watermark";

/**
 * Turns an encyclopedia sentence into something an image model can
 * draw. Prose carries clauses, dates and numbers that become noise in a
 * prompt, so this keeps the concrete opening of the sentence and leans
 * on the topic for context.
 */
export function buildImagePrompt(topic: string, sentence: string): string {
  const cleaned = sentence
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    // Dates and bare numbers describe facts, not pictures
    .replace(/\b\d{1,4}(?:[–-]\d{1,4})?\b/g, " ")
    .replace(/["“”]/g, "")
    // Removing the dates strands the words that introduced them
    // ("last erupted from to and has been quiet"), which only confuses
    // the model. A surviving noun keeps the pair apart ("from Tokyo to
    // Kyoto"), so adjacency is what marks the gap.
    .replace(/\b(from|between)\s+(to|and)\b/gi, " ")
    .replace(
      /\b(from|between|in|around|about|circa|since|until|during|by)\s+(to|and|the)?\s*(?=[.,;:]|$)/gi,
      " ",
    )
    .replace(/\s+([.,;:])/g, "$1")
    .replace(/\.{2,}/g, ".")
    .replace(/\s{2,}/g, " ")
    .replace(/[\s,;:]+$/, "")
    .trim();

  // The first clause is usually the visual one; later clauses qualify it
  const firstClause = cleaned.split(/[,;:]/)[0]?.trim() ?? cleaned;
  const subject = (firstClause.length >= 25 ? firstClause : cleaned)
    .slice(0, 180)
    .replace(/[\s.,;:]+$/, "");
  // Whatever survived may be too thin to draw; the topic alone is a
  // better prompt than a fragment
  const usable = subject.replace(/[^A-Za-z]/g, "").length >= 12;
  return usable
    ? `${topic}. ${subject}. ${STYLE_SUFFIX}`
    : `${topic}. ${STYLE_SUFFIX}`;
}

/** A free public service refuses under load; these are worth waiting out. */
const ATTEMPT_DELAYS_MS = [0, 3000, 8000];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Generates one scene picture. Returns false when the service could not
 * produce one, so the caller can fall back rather than lose the scene.
 */
export async function generateSceneImage(options: {
  prompt: string;
  outPath: string;
  width: number;
  height: number;
  /** Fixed per scene so a retry of the same video looks the same */
  seed: number;
}): Promise<boolean> {
  let lastError = "";
  for (const [attempt, delay] of ATTEMPT_DELAYS_MS.entries()) {
    if (delay) await sleep(delay);
    const query = new URLSearchParams({
      width: String(options.width),
      height: String(options.height),
      seed: String(options.seed),
      nologo: "true",
    });
    // The default model is the most reliable; ask for flux first because
    // it draws better, then fall back rather than lose the picture
    if (attempt === 0) query.set("model", "flux");
    const url = `${ENDPOINT}/${encodeURIComponent(options.prompt)}?${query}`;

    try {
      const response = await fetch(url, {
        headers: { "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "follow",
      });
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`);
      }
      await pipeline(
        response.body as unknown as Readable,
        createWriteStream(options.outPath),
      );
      // A truncated or error-page response is worse than no picture: it
      // would render as a broken frame
      const { size } = await stat(options.outPath);
      if (size < 2048) throw new Error(`image too small (${size} bytes)`);
      return true;
    } catch (err) {
      lastError = String(err).slice(0, 160);
      await unlink(options.outPath).catch(() => undefined);
      if (attempt < ATTEMPT_DELAYS_MS.length - 1) {
        console.warn(
          `Scene image attempt ${attempt + 1} failed (${lastError}), retrying`,
        );
      }
    }
  }
  console.warn(`Scene image generation gave up: ${lastError}`);
  return false;
}
