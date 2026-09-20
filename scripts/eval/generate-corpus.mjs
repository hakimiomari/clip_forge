/**
 * Generates the highlight-evaluation corpus: synthetic videos whose
 * "interesting" segments (high-energy speech-like audio) sit at KNOWN
 * timestamps — the ground truth for temporal-IoU scoring.
 *
 * Usage: node scripts/eval/generate-corpus.mjs [videoCount]
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const execFileP = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const corpusDir = path.join(here, "corpus");

const VIDEO_COUNT = Number(process.argv[2] ?? 6);
const DURATION = 150;

// Deterministic PRNG so the corpus is reproducible run-to-run
let seed = 42;
function rand() {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}

function makeGroundTruth() {
  // 2 non-overlapping segments of 20–35s with clean silence around them
  const len1 = 20 + Math.round(rand() * 15);
  const len2 = 20 + Math.round(rand() * 15);
  const start1 = 10 + Math.round(rand() * 30);
  const start2 = start1 + len1 + 15 + Math.round(rand() * 25);
  const end2 = Math.min(start2 + len2, DURATION - 8);
  return [
    { start: start1, end: start1 + len1 },
    { start: start2, end: end2 },
  ].filter((g) => g.end - g.start >= 15);
}

await mkdir(corpusDir, { recursive: true });
const manifest = { duration: DURATION, videos: [] };

for (let i = 0; i < VIDEO_COUNT; i++) {
  const gt = makeGroundTruth();
  const file = `eval_${String(i + 1).padStart(2, "0")}.mp4`;
  // Speech-like bursts: warbling tone inside GT windows, silence outside
  const gate = gt.map((g) => `between(t,${g.start},${g.end})`).join("+");
  const freq = 160 + Math.round(rand() * 120);
  const audioExpr = `0.55*sin(2*PI*(${freq}+70*sin(t*${(2 + rand() * 2).toFixed(2)}))*t)*(${gate})`;

  console.log(`generating ${file}  GT: ${gt.map((g) => `${g.start}-${g.end}s`).join(", ")}`);
  await execFileP("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `testsrc2=size=854x480:rate=30:duration=${DURATION}`,
    "-f", "lavfi", "-i", `aevalsrc='${audioExpr}':s=44100:d=${DURATION}`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "96k", "-shortest",
    path.join(corpusDir, file),
  ]);
  manifest.videos.push({ file, groundTruth: gt });
}

await writeFile(
  path.join(corpusDir, "manifest.json"),
  JSON.stringify(manifest, null, 2),
);
console.log(`\ncorpus ready: ${VIDEO_COUNT} videos + manifest.json in scripts/eval/corpus/`);
