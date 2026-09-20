import { spawn } from "child_process";
import { readFile, stat } from "fs/promises";
import { env, FFMPEG } from "../env";
import { track } from "./children";
import type { TranscriptSegmentLite } from "./heuristics";

/**
 * Transcription providers (Transcript Agent). Adapters for OpenAI Whisper
 * and Deepgram; "none" disables transcription (captions unavailable but
 * the rest of the pipeline still works).
 */

export interface TranscriptionResult {
  language: string | null;
  segments: TranscriptSegmentLite[];
  provider: string;
}

export function transcriptionConfigured(): boolean {
  return (
    (env.TRANSCRIPTION_PROVIDER === "openai" ||
      env.TRANSCRIPTION_PROVIDER === "deepgram") &&
    Boolean(env.TRANSCRIPTION_API_KEY)
  );
}

export async function transcribeAudio(
  audioPath: string,
  workFile: (name: string) => string,
): Promise<TranscriptionResult> {
  if (!transcriptionConfigured()) {
    throw new Error(
      "No transcription provider configured (set TRANSCRIPTION_PROVIDER + TRANSCRIPTION_API_KEY)",
    );
  }

  // OpenAI caps uploads at 25 MB — shrink to mono Opus when needed
  let uploadPath = audioPath;
  const { size } = await stat(audioPath);
  if (env.TRANSCRIPTION_PROVIDER === "openai" && size > 24 * 1024 * 1024) {
    uploadPath = workFile("audio-small.ogg");
    await runFfmpeg([
      "-y", "-i", audioPath,
      "-vn", "-ac", "1", "-ar", "16000",
      "-c:a", "libopus", "-b:a", "24k",
      uploadPath,
    ]);
  }

  return env.TRANSCRIPTION_PROVIDER === "openai"
    ? transcribeOpenAI(uploadPath)
    : transcribeDeepgram(uploadPath);
}

async function transcribeOpenAI(audioPath: string): Promise<TranscriptionResult> {
  const bytes = await readFile(audioPath);
  const form = new FormData();
  const fileName = audioPath.toLowerCase().endsWith(".ogg") ? "audio.ogg" : "audio.m4a";
  form.append("file", new Blob([new Uint8Array(bytes)]), fileName);
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { authorization: `Bearer ${env.TRANSCRIPTION_API_KEY}` },
    body: form,
  });
  if (!res.ok) {
    throw new Error(`Whisper API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    language?: string;
    segments?: Array<{ start: number; end: number; text: string }>;
    text?: string;
  };
  const segments = (data.segments ?? [])
    .map((s) => ({
      startTime: s.start,
      endTime: s.end,
      text: s.text.trim(),
    }))
    .filter((s) => s.text.length > 0);
  if (segments.length === 0 && data.text) {
    segments.push({ startTime: 0, endTime: 1, text: data.text.trim() });
  }
  return { language: data.language ?? null, segments, provider: "openai-whisper" };
}

async function transcribeDeepgram(audioPath: string): Promise<TranscriptionResult> {
  const bytes = await readFile(audioPath);
  const res = await fetch(
    "https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&utterances=true&detect_language=true",
    {
      method: "POST",
      headers: {
        authorization: `Token ${env.TRANSCRIPTION_API_KEY}`,
        "content-type": "audio/mp4",
      },
      body: new Uint8Array(bytes),
    },
  );
  if (!res.ok) {
    throw new Error(`Deepgram API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    results?: {
      utterances?: Array<{ start: number; end: number; transcript: string }>;
      channels?: Array<{
        detected_language?: string;
        alternatives?: Array<{ transcript?: string }>;
      }>;
    };
  };
  const segments = (data.results?.utterances ?? [])
    .map((u) => ({ startTime: u.start, endTime: u.end, text: u.transcript.trim() }))
    .filter((s) => s.text.length > 0);
  return {
    language: data.results?.channels?.[0]?.detected_language ?? null,
    segments,
    provider: "deepgram",
  };
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = track(spawn(FFMPEG, args, { windowsHide: true }));
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-400)}`)),
    );
  });
}
