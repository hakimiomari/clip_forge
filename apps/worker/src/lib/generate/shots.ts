import {
  planShots,
  styleSuffix,
  type GeneratedEngine,
  type GeneratedShot,
} from "@clipforge/shared-types";
import { completeText, extractJson, llmConfigured } from "../llm";

/**
 * The shot list for a video. The fixed camera directions in `planShots`
 * work without any model; when a language model is configured it writes
 * proper shots instead — the same setting seen from different places,
 * in an order that reads as one scene. Anything odd from the model
 * falls back to the fixed plan.
 */
export async function planShotsForVideo(
  prompt: string,
  targetSeconds: number,
  engine: GeneratedEngine,
  style: string,
): Promise<GeneratedShot[]> {
  const base = planShots(prompt, targetSeconds, engine, style);
  if (base.length < 2 || !llmConfigured()) return base;

  try {
    const text = await completeText(
      `You are directing a short video about: "${prompt}".\n` +
        `Write ${base.length} distinct shots, in order, that together show this ` +
        `subject from different angles and distances in the same setting. ` +
        `Each shot is one sentence describing exactly what the camera sees and ` +
        `how it moves. No dialogue, no text on screen.\n` +
        `Reply with a JSON array of ${base.length} strings and nothing else.`,
    );
    const list = extractJson<unknown>(text);
    const usable =
      Array.isArray(list) &&
      list.length === base.length &&
      list.every((s) => typeof s === "string" && s.trim().length > 10);
    if (!usable) return base;
    const suffix = styleSuffix(style);
    return base.map((shot, i) => ({
      ...shot,
      prompt: `${(list as string[])[i]!.trim().replace(/[.\s]+$/, "")}. ${suffix}`,
    }));
  } catch (err) {
    console.warn(`Shot planning by LLM failed, using the fixed plan: ${String(err).slice(0, 160)}`);
    return base;
  }
}
