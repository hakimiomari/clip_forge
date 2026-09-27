/**
 * AI video: a text prompt becomes a short video made of generated shots.
 *
 * Which engine draws the shots depends on the keys in the environment —
 * a real video model when one is configured, otherwise a free image
 * engine whose pictures get camera motion. The same request, progress
 * and result shape apply whichever engine ran.
 */

export type GeneratedEngine = "veo" | "sora" | "images";
export type GeneratedStyle = "cinematic" | "photoreal" | "anime" | "cartoon" | "documentary";
export type GeneratedFormat = "vertical" | "square" | "landscape";

export const GENERATED_VIDEO_CREDITS = 8;
/** Finished lengths offered, in seconds. */
export const GENERATED_LENGTHS = [8, 16, 24] as const;
export const MIN_GENERATED_SECONDS = 4;
export const MAX_GENERATED_SECONDS = 32;
/** Most shots one video is built from. */
export const MAX_GENERATED_SHOTS = 6;

export const GENERATED_RESOLUTIONS: Record<GeneratedFormat, { width: number; height: number }> = {
  vertical: { width: 1080, height: 1920 },
  square: { width: 1080, height: 1080 },
  landscape: { width: 1920, height: 1080 },
};

export const GENERATED_STYLES: Array<{
  value: GeneratedStyle;
  label: string;
  /** Appended to every shot prompt so the shots share one look */
  suffix: string;
}> = [
  {
    value: "cinematic",
    label: "Cinematic",
    suffix: "cinematic lighting, shallow depth of field, subtle film grain, 35mm lens",
  },
  {
    value: "photoreal",
    label: "Photoreal",
    suffix: "ultra realistic, natural lighting, sharp detail, photographic",
  },
  {
    value: "anime",
    label: "Anime",
    suffix: "anime illustration, studio ghibli style, hand painted, soft lighting",
  },
  {
    value: "cartoon",
    label: "Cartoon",
    suffix: "3D cartoon, pixar style, vibrant colours, soft shading",
  },
  {
    value: "documentary",
    label: "Documentary",
    suffix: "documentary footage, handheld camera, natural colours",
  },
];

export const GENERATED_ENGINES: Record<
  GeneratedEngine,
  {
    label: string;
    /** Shown beside the engine name on the page */
    note: string;
    /** Length of one generated shot */
    shotSeconds: number;
    /** True when the engine makes moving video rather than pictures */
    realVideo: boolean;
  }
> = {
  veo: {
    label: "Google Veo 3.1",
    note: "Real generated video with sound.",
    shotSeconds: 8,
    realVideo: true,
  },
  sora: {
    label: "OpenAI Sora 2",
    note: "Real generated video with sound.",
    shotSeconds: 8,
    realVideo: true,
  },
  images: {
    label: "Free image engine",
    note:
      "AI-drawn pictures with camera motion, no sound. Add GEMINI_API_KEY or " +
      "OPENAI_API_KEY to .env for real video.",
    shotSeconds: 4,
    realVideo: false,
  },
};

/**
 * The engine the environment allows: a forced choice via VIDEO_ENGINE,
 * else the first real video model with a key, else the free engine.
 */
export function pickGeneratedEngine(
  env: Record<string, string | undefined>,
): GeneratedEngine {
  const forced = env.VIDEO_ENGINE?.trim().toLowerCase();
  if (forced === "veo" || forced === "sora" || forced === "images") return forced;
  if (env.GEMINI_API_KEY?.trim()) return "veo";
  if (env.OPENAI_API_KEY?.trim()) return "sora";
  return "images";
}

export interface GeneratedShot {
  index: number;
  /** The full prompt sent to the engine for this shot */
  prompt: string;
  seconds: number;
}

/**
 * Camera directions cycled across shots, so a multi-shot video moves
 * through the scene instead of repeating one picture.
 */
export const CAMERA_DIRECTIONS = [
  "wide establishing shot",
  "medium shot, slow push-in",
  "close-up on the main subject",
  "slow tracking shot from the side",
  "low angle, dramatic perspective",
  "over-the-shoulder view, slow pan",
] as const;

export function styleSuffix(style: string): string {
  return GENERATED_STYLES.find((s) => s.value === style)?.suffix ?? GENERATED_STYLES[0]!.suffix;
}

/** Splits the request into shots of the engine's length, each with its own camera direction. */
export function planShots(
  prompt: string,
  targetSeconds: number,
  engine: GeneratedEngine,
  style: string,
): GeneratedShot[] {
  const { shotSeconds } = GENERATED_ENGINES[engine];
  const count = Math.max(
    1,
    Math.min(MAX_GENERATED_SHOTS, Math.ceil(targetSeconds / shotSeconds)),
  );
  const base = prompt.trim().replace(/[.\s]+$/, "");
  const suffix = styleSuffix(style);
  return Array.from({ length: count }, (_, index) => ({
    index,
    seconds: shotSeconds,
    prompt: `${base}. ${CAMERA_DIRECTIONS[index % CAMERA_DIRECTIONS.length]}. ${suffix}`,
  }));
}

export interface GeneratedVideoSummary {
  id: string;
  prompt: string;
  title: string | null;
  description: string | null;
  status: "PENDING" | "RESEARCHING" | "BUILDING" | "RENDERING" | "READY" | "FAILED";
  error: string | null;
  format: string;
  style: string;
  /** Engine that made it; null until the build starts */
  engine: GeneratedEngine | null;
  targetSeconds: number | null;
  progress: number;
  step: string | null;
  duration: number | null;
  createdAt: string;
  /** Presigned, only when the video is READY */
  videoUrl?: string | null;
  shots?: GeneratedShot[] | null;
}
