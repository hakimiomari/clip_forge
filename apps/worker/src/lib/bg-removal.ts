import { spawn } from "child_process";
import { createWriteStream, existsSync } from "fs";
import { mkdir, rename, writeFile } from "fs/promises";
import path from "path";
import { FFMPEG } from "../env";
import { track } from "./children";

/**
 * AI background removal (subject cut-out).
 *
 * Per-frame salient-object segmentation with U²-Net-P (the compact
 * model used by rembg) via onnxruntime-node, entirely local and
 * CPU-only. Frames stream through ffmpeg as raw RGB; masks stream back
 * out as a raw 8-bit alpha video the render filtergraph alphamerges
 * with the source. Best suited to single-subject footage.
 */

const MODEL_URL =
  "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx";
const SIZE = 320; // model input resolution
const FRAME_BYTES = SIZE * SIZE * 3;
export const MASK_FPS = 30;

// ImageNet normalization used by U²-Net
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

/** rgb24 frame → normalized CHW float tensor data. */
export function preprocessFrame(rgb: Uint8Array): Float32Array {
  const out = new Float32Array(3 * SIZE * SIZE);
  const px = SIZE * SIZE;
  for (let i = 0; i < px; i++) {
    for (let c = 0; c < 3; c++) {
      out[c * px + i] = (rgb[i * 3 + c]! / 255 - MEAN[c]!) / STD[c]!;
    }
  }
  return out;
}

/** Model output → min-max normalized 8-bit mask, blended with previous. */
export function postprocessMask(
  pred: Float32Array,
  previous: Uint8Array | null,
): Uint8Array {
  let min = Infinity;
  let max = -Infinity;
  for (const v of pred) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min || 1;
  const mask = new Uint8Array(pred.length);
  for (let i = 0; i < pred.length; i++) {
    let value = ((pred[i]! - min) / range) * 255;
    // Temporal smoothing tames frame-to-frame flicker
    if (previous) value = value * 0.7 + previous[i]! * 0.3;
    mask[i] = value;
  }
  return mask;
}

export async function ensureModel(): Promise<string> {
  const dir = path.resolve(process.cwd(), "../../.models");
  const file = path.join(dir, "u2netp.onnx");
  if (existsSync(file)) return file;
  await mkdir(dir, { recursive: true });
  console.log("Downloading segmentation model (u2netp, ~4.5 MB)…");
  const res = await fetch(MODEL_URL, { redirect: "follow" });
  if (!res.ok) throw new Error(`Model download failed: HTTP ${res.status}`);
  const tmp = `${file}.download`;
  await writeFile(tmp, Buffer.from(await res.arrayBuffer()));
  await rename(tmp, file);
  return file;
}

/**
 * Streams the clip window through the model and writes a raw gray8
 * 320×320 mask video aligned to MASK_FPS. Returns the frame count.
 */
export async function generateMaskVideo(options: {
  inputPath: string;
  start: number;
  duration: number;
  outPath: string;
  onProgress?: (fraction: number) => void;
}): Promise<number> {
  // Lazy import: onnxruntime-node is only loaded when the feature is used
  const ort = await import("onnxruntime-node");
  const modelPath = await ensureModel();
  const session = await ort.InferenceSession.create(modelPath, {
    executionProviders: ["cpu"],
    graphOptimizationLevel: "all",
  });
  const inputName = session.inputNames[0]!;
  const outputName = session.outputNames[0]!;

  const expectedFrames = Math.ceil(options.duration * MASK_FPS);
  const child = track(
    spawn(
      FFMPEG,
      [
        "-nostdin", "-hide_banner", "-loglevel", "error",
        "-ss", options.start.toFixed(3),
        "-t", options.duration.toFixed(3),
        "-i", options.inputPath,
        "-vf", `fps=${MASK_FPS},scale=${SIZE}:${SIZE}`,
        "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
      ],
      { windowsHide: true },
    ),
  );
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString().slice(-4000)));

  const out = createWriteStream(options.outPath);
  let pending: Buffer = Buffer.alloc(0);
  let frames = 0;
  let previous: Uint8Array | null = null;

  for await (const chunk of child.stdout) {
    pending = pending.length === 0 ? (chunk as Buffer) : Buffer.concat([pending, chunk as Buffer]);
    while (pending.length >= FRAME_BYTES) {
      const frame = pending.subarray(0, FRAME_BYTES);
      pending = pending.subarray(FRAME_BYTES);
      const tensor = new ort.Tensor("float32", preprocessFrame(frame), [1, 3, SIZE, SIZE]);
      const result = await session.run({ [inputName]: tensor });
      const pred = result[outputName]!.data as Float32Array;
      const mask = postprocessMask(pred, previous);
      previous = mask;
      if (!out.write(Buffer.from(mask))) {
        await new Promise<void>((r) => out.once("drain", () => r()));
      }
      frames++;
      if (frames % 15 === 0) {
        options.onProgress?.(Math.min(0.99, frames / expectedFrames));
      }
    }
  }

  await new Promise<void>((resolve, reject) => {
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`frame extraction failed: ${stderr.slice(-400)}`)),
    );
  });
  await new Promise<void>((resolve) => out.end(resolve));
  if (frames === 0) throw new Error("Background removal produced no frames");
  return frames;
}
