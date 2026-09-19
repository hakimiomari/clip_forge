import { z } from "zod";
import { existsSync, readFileSync } from "fs";
import path from "path";

/**
 * Minimal .env loader so the worker shares the repo-root .env with the
 * API in development without extra dependencies.
 */
function loadDotEnv(): void {
  for (const candidate of [".env", "../../.env", "../.env"]) {
    const file = path.resolve(process.cwd(), candidate);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match) continue;
      const key = match[1];
      let value = match[2] ?? "";
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
    break;
  }
}

loadDotEnv();

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default("us-east-1"),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_FORCE_PATH_STYLE: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),
  FFMPEG_PATH: z.string().optional(),
  FFPROBE_PATH: z.string().optional(),
  YOUTUBE_API_KEY: z.string().optional(),
  // AI providers (all optional — heuristic fallback works without keys)
  AI_PROVIDER: z.enum(["anthropic", "openai", "heuristic", "mock"]).default("heuristic"),
  AI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default("claude-sonnet-5"),
  TRANSCRIPTION_PROVIDER: z.enum(["openai", "deepgram", "none", "mock"]).default("none"),
  TRANSCRIPTION_API_KEY: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  // eslint-disable-next-line no-console
  console.error(`Worker: invalid environment configuration:\n${issues}`);
  process.exit(1);
}

export const env = parsed.data;
export const FFMPEG = env.FFMPEG_PATH?.trim() || "ffmpeg";
export const FFPROBE = env.FFPROBE_PATH?.trim() || "ffprobe";
