import { spawn } from "child_process";
import { existsSync } from "fs";
import { mkdir, rename, writeFile } from "fs/promises";
import path from "path";
import { FFMPEG, FFPROBE } from "../env";
import { track } from "./children";

/**
 * Cartoon / anime stylization of real footage, using AnimeGANv3 through
 * onnxruntime-node — entirely local and CPU-only, like the background
 * removal model. Frames stream out of ffmpeg as raw RGB, through the
 * model, and straight back into an encoder, so memory stays flat no
 * matter how long the clip is.
 *
 * The result is a normal video file that replaces the render input, so
 * captions, effects, the banner and the watermark all still apply on
 * top of it.
 */

export type CartoonStyle = "hayao" | "shinkai";

const MODEL_URLS: Record<CartoonStyle, string> = {
  // Ghibli-like: soft shading, painterly backgrounds
  hayao:
    "https://github.com/TachibanaYoshino/AnimeGANv3/releases/download/v1.1.0/AnimeGANv3_Hayao_36.onnx",
  // Shinkai-like: high contrast, saturated skies
  shinkai:
    "https://github.com/TachibanaYoshino/AnimeGANv3/releases/download/v1.1.0/AnimeGANv3_Shinkai_37.onnx",
};

/**
 * Real animation is drawn on twos or threes, so 12 fps reads as *more*
 * cartoon-like than 30 — and costs 2.5x less inference.
 */
export const DEFAULT_CARTOON_FPS = 12;
/**
 * Long edge fed to the model.
 *
 * "high" matches a 1080-wide export, so stylized frames go into the
 * render at their final size with no upscale — visibly sharper faces
 * and edges. "standard" is the fast draft setting. Measured on CPU:
 * ~170 ms/frame at 512, ~260 ms at 720, ~620 ms at 1024.
 */
export const CARTOON_LONG_EDGE: Record<CartoonQuality, number> = {
  standard: 512,
  // Ceiling only: the caller lowers this to the export's own width, and
  // the source's size lowers it again, so nothing is ever upscaled
  high: 1920,
};

export type CartoonQuality = "standard" | "high";

/**
 * Model input size: the requested long edge, but never larger than the
 * source itself — enlarging before stylizing costs time and invents no
 * detail. Both sides must be a multiple of 8 for the network.
 */
export function modelDimensions(
  width: number,
  height: number,
  longEdge: number,
): { width: number; height: number } {
  const sourceLongEdge = Math.max(width, height);
  const target = Math.min(longEdge, sourceLongEdge);
  const scale = target / sourceLongEdge;
  const round8 = (n: number) => Math.max(8, Math.round(n / 8) * 8);
  return { width: round8(width * scale), height: round8(height * scale) };
}

/** AnimeGANv3 takes and returns RGB in [-1, 1]. */
export function toModelValue(byte: number): number {
  return byte / 127.5 - 1;
}

export function fromModelValue(value: number): number {
  const byte = Math.round((value + 1) * 127.5);
  return byte < 0 ? 0 : byte > 255 ? 255 : byte;
}

export async function ensureCartoonModel(style: CartoonStyle): Promise<string> {
  const dir =
    process.env.MODELS_DIR?.trim() ||
    path.join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".clipforge", "models");
  const file = path.join(dir, `animeganv3-${style}.onnx`);
  if (existsSync(file)) return file;
  await mkdir(dir, { recursive: true });
  console.log(`Downloading cartoon model (AnimeGANv3 ${style}, ~4 MB)…`);
  const res = await fetch(MODEL_URLS[style], { redirect: "follow" });
  if (!res.ok) throw new Error(`Cartoon model download failed: HTTP ${res.status}`);
  const tmp = `${file}.download`;
  await writeFile(tmp, Buffer.from(await res.arrayBuffer()));
  await rename(tmp, file);
  return file;
}

/**
 * Stylizes [start, start+duration) of `inputPath` into `outPath`, a
 * normal MP4 carrying the window's original audio.
 */
export async function stylizeVideo(options: {
  inputPath: string;
  start: number;
  duration: number;
  outPath: string;
  style: CartoonStyle;
  sourceWidth: number;
  sourceHeight: number;
  fps?: number;
  longEdge?: number;
  hasAudio: boolean;
  onProgress?: (fraction: number) => void;
}): Promise<number> {
  // Lazy import: onnxruntime-node only loads when the feature is used
  const ort = await import("onnxruntime-node");
  const modelPath = await ensureCartoonModel(options.style);
  const session = await ort.InferenceSession.create(modelPath, {
    executionProviders: ["cpu"],
    graphOptimizationLevel: "all",
  });
  const inputName = session.inputNames[0]!;
  const outputName = session.outputNames[0]!;

  const fps = options.fps ?? DEFAULT_CARTOON_FPS;
  const { width, height } = modelDimensions(
    options.sourceWidth,
    options.sourceHeight,
    options.longEdge ?? CARTOON_LONG_EDGE.high,
  );
  const frameBytes = width * height * 3;
  const expectedFrames = Math.max(1, Math.ceil(options.duration * fps));

  const decoder = track(
    spawn(
      FFMPEG,
      [
        "-nostdin", "-hide_banner", "-loglevel", "error",
        "-ss", options.start.toFixed(3),
        "-t", options.duration.toFixed(3),
        "-i", options.inputPath,
        "-an",
        // Lanczos keeps edges crisp going into the model, which matters
        // more here than usual: the model amplifies whatever it is given
        "-vf", `fps=${fps},scale=${width}:${height}:flags=lanczos`,
        "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
      ],
      { windowsHide: true },
    ),
  );

  // Encoder takes stylized frames on stdin; the original audio for the
  // same window comes straight from the source as a second input.
  const encoderArgs = [
    "-nostdin", "-hide_banner", "-loglevel", "error",
    "-f", "rawvideo", "-pix_fmt", "rgb24",
    "-s", `${width}x${height}`,
    "-framerate", String(fps),
    "-i", "pipe:0",
  ];
  if (options.hasAudio) {
    encoderArgs.push(
      "-ss", options.start.toFixed(3),
      "-t", options.duration.toFixed(3),
      "-i", options.inputPath,
      "-map", "0:v", "-map", "1:a",
      "-c:a", "aac", "-b:a", "192k",
    );
  }
  encoderArgs.push(
    "-c:v", "libx264",
    "-preset", "veryfast",
    // Near-lossless: this intermediate is re-encoded by the real render,
    // so generation loss here would show up in the final clip
    "-crf", "14",
    "-pix_fmt", "yuv420p",
    "-shortest",
    "-y", options.outPath,
  );
  const encoder = track(spawn(FFMPEG, encoderArgs, { windowsHide: true }));

  let decoderErr = "";
  let encoderErr = "";
  decoder.stderr.on("data", (d: Buffer) => (decoderErr += d.toString().slice(-4000)));
  encoder.stderr.on("data", (d: Buffer) => (encoderErr += d.toString().slice(-4000)));

  // Attach exit handlers before consuming stdout, or 'close' can fire first
  const decoderExit = new Promise<void>((resolve, reject) => {
    decoder.on("error", (err) =>
      reject(new Error(`cartoon frame read failed to start: ${err.message}`)),
    );
    decoder.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`cartoon frame read failed: ${decoderErr.slice(-400)}`)),
    );
  });
  const encoderExit = new Promise<void>((resolve, reject) => {
    encoder.on("error", (err) =>
      reject(new Error(`cartoon encode failed to start: ${err.message}`)),
    );
    encoder.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`cartoon encode failed: ${encoderErr.slice(-400)}`)),
    );
  });

  const input = new Float32Array(frameBytes);
  const outBuffer = Buffer.alloc(frameBytes);
  let pending: Buffer = Buffer.alloc(0);
  let frames = 0;

  try {
    for await (const chunk of decoder.stdout) {
      pending =
        pending.length === 0 ? (chunk as Buffer) : Buffer.concat([pending, chunk as Buffer]);
      while (pending.length >= frameBytes) {
        const frame = pending.subarray(0, frameBytes);
        pending = pending.subarray(frameBytes);
        for (let i = 0; i < frameBytes; i++) input[i] = toModelValue(frame[i]!);
        const result = await session.run({
          [inputName]: new ort.Tensor("float32", input, [1, height, width, 3]),
        });
        const values = result[outputName]!.data as Float32Array;
        for (let i = 0; i < frameBytes; i++) outBuffer[i] = fromModelValue(values[i]!);
        if (!encoder.stdin.write(outBuffer)) {
          await new Promise((resolve) => encoder.stdin.once("drain", resolve));
        }
        frames++;
        options.onProgress?.(Math.min(1, frames / expectedFrames));
      }
    }
  } finally {
    encoder.stdin.end();
  }

  await decoderExit;
  await encoderExit;
  if (frames === 0) throw new Error("Cartoon stylization produced no frames");
  return frames;
}

/**
 * Sessions are cached per style: a research video stylizes up to eight
 * pictures in a row, and rebuilding the session for each one costs more
 * than the inference itself.
 */
const sessionCache = new Map<CartoonStyle, Promise<CartoonSession>>();

interface CartoonSession {
  run(input: Float32Array, height: number, width: number): Promise<Float32Array>;
}

async function getCartoonSession(style: CartoonStyle): Promise<CartoonSession> {
  let cached = sessionCache.get(style);
  if (!cached) {
    cached = (async () => {
      const ort = await import("onnxruntime-node");
      const modelPath = await ensureCartoonModel(style);
      const session = await ort.InferenceSession.create(modelPath, {
        executionProviders: ["cpu"],
        graphOptimizationLevel: "all",
      });
      const inputName = session.inputNames[0]!;
      const outputName = session.outputNames[0]!;
      return {
        async run(input: Float32Array, height: number, width: number) {
          const result = await session.run({
            [inputName]: new ort.Tensor("float32", input, [1, height, width, 3]),
          });
          return result[outputName]!.data as Float32Array;
        },
      };
    })();
    sessionCache.set(style, cached);
  }
  return cached;
}

/** Pixel dimensions of an image or the first video frame. */
export async function probePixelSize(
  filePath: string,
): Promise<{ width: number; height: number }> {
  const args = [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-of", "csv=p=0:s=x",
    filePath,
  ];
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = track(spawn(FFPROBE, args, { windowsHide: true }));
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString().slice(-2000)));
    child.on("error", (e) => reject(new Error(`ffprobe failed to start: ${e.message}`)));
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`ffprobe failed: ${err.slice(-300)}`)),
    );
  });
  const [w, h] = stdout.trim().split(/\r?\n/)[0]!.split("x").map(Number);
  if (!w || !h) throw new Error(`could not read dimensions of ${path.basename(filePath)}`);
  return { width: w, height: h };
}

/**
 * Stylizes a single picture. A still needs one inference rather than one
 * per frame, so research scenes built from photographs cost a fraction
 * of what stylizing their rendered video would.
 */
/** Model activations grow with the frame; this is where CPU RAM gives out. */
function isAllocationFailure(err: unknown): boolean {
  return /Failed to allocate|bad_alloc|Cannot allocate memory|out of memory/i.test(
    String(err),
  );
}

/** Default for a single picture: sharp enough for a 1080-wide frame. */
export const IMAGE_LONG_EDGE = 1024;
const MIN_IMAGE_LONG_EDGE = 384;

export async function stylizeImage(options: {
  inputPath: string;
  outPath: string;
  style: CartoonStyle;
  longEdge?: number;
}): Promise<void> {
  let longEdge = options.longEdge ?? IMAGE_LONG_EDGE;
  for (;;) {
    try {
      await stylizeImageAt({ ...options, longEdge });
      return;
    } catch (err) {
      // A big photograph can ask for more memory than the machine has
      // free; halving the model input is far better than losing the scene
      if (!isAllocationFailure(err) || longEdge <= MIN_IMAGE_LONG_EDGE) throw err;
      longEdge = Math.max(MIN_IMAGE_LONG_EDGE, Math.floor(longEdge / 2));
      console.warn(
        `Cartoon ran out of memory, retrying at ${longEdge}px: ${String(err).slice(0, 120)}`,
      );
    }
  }
}

async function stylizeImageAt(options: {
  inputPath: string;
  outPath: string;
  style: CartoonStyle;
  longEdge: number;
}): Promise<void> {
  const session = await getCartoonSession(options.style);
  const source = await probePixelSize(options.inputPath);
  const { width, height } = modelDimensions(
    source.width,
    source.height,
    options.longEdge,
  );
  const frameBytes = width * height * 3;

  const decoded = await new Promise<Buffer>((resolve, reject) => {
    const child = track(
      spawn(
        FFMPEG,
        [
          "-nostdin", "-hide_banner", "-loglevel", "error",
          "-i", options.inputPath,
          "-frames:v", "1",
          "-vf", `scale=${width}:${height}:flags=lanczos`,
          "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
        ],
        { windowsHide: true },
      ),
    );
    const parts: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (d: Buffer) => parts.push(d));
    child.stderr.on("data", (d: Buffer) => (err += d.toString().slice(-2000)));
    child.on("error", (e) => reject(new Error(`cartoon image read failed: ${e.message}`)));
    child.on("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(parts))
        : reject(new Error(`cartoon image read failed: ${err.slice(-300)}`)),
    );
  });
  if (decoded.length < frameBytes) {
    throw new Error("cartoon image read produced no frame");
  }

  const input = new Float32Array(frameBytes);
  for (let i = 0; i < frameBytes; i++) input[i] = toModelValue(decoded[i]!);
  const values = await session.run(input, height, width);
  const out = Buffer.alloc(frameBytes);
  for (let i = 0; i < frameBytes; i++) out[i] = fromModelValue(values[i]!);

  await new Promise<void>((resolve, reject) => {
    const child = track(
      spawn(
        FFMPEG,
        [
          "-nostdin", "-hide_banner", "-loglevel", "error",
          "-f", "rawvideo", "-pix_fmt", "rgb24",
          "-s", `${width}x${height}`,
          "-i", "pipe:0",
          "-frames:v", "1", "-y", options.outPath,
        ],
        { windowsHide: true },
      ),
    );
    let err = "";
    child.stderr.on("data", (d: Buffer) => (err += d.toString().slice(-2000)));
    child.on("error", (e) => reject(new Error(`cartoon image write failed: ${e.message}`)));
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`cartoon image write failed: ${err.slice(-300)}`)),
    );
    child.stdin.end(out);
  });
}
