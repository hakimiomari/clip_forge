/**
 * Highlight-quality benchmark (Layer 4 of the evaluation framework) +
 * transformation robustness (Layer 3, aimed at the highlight selector).
 *
 * Runs the REAL production pipeline (analyzeMedia → selectHighlights)
 * against the ground-truth corpus and reports:
 *   - temporal IoU per ground-truth segment (best-matching suggestion)
 *   - hit rate (IoU ≥ 0.5), start/end mean absolute error
 *   - with --variants: highlight stability under compression, resize,
 *     brightness, fps reduction and speed change
 *
 * Usage: node scripts/eval/run-eval.mjs [--variants]
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dist = path.join(repo, "apps/worker/dist/lib");
const { analyzeMedia } = await import(`file://${dist}/analysis.js`);
const { selectHighlights } = await import(`file://${dist}/heuristics.js`);
const execFileP = promisify(execFile);

const here = path.dirname(fileURLToPath(import.meta.url));
const corpusDir = path.join(here, "corpus");
const variantDir = path.join(corpusDir, "variants");
const withVariants = process.argv.includes("--variants");

const manifest = JSON.parse(await readFile(path.join(corpusDir, "manifest.json"), "utf8"));
const DURATION = manifest.duration;

// ── metrics ───────────────────────────────────────────────
const iou = (a, b) => {
  const inter = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  const union = a.end - a.start + (b.end - b.start) - inter;
  return union > 0 ? inter / union : 0;
};

async function suggest(file, duration = DURATION) {
  const analysis = await analyzeMedia({ audio: file, video: file, durationSeconds: duration });
  return selectHighlights({ duration, targetLength: 30, count: 3, analysis }).map(
    (h) => ({ start: h.startTime, end: h.endTime }),
  );
}

function scoreAgainstGT(suggestions, groundTruth) {
  return groundTruth.map((gt) => {
    let best = { iou: 0, startErr: NaN, endErr: NaN };
    for (const s of suggestions) {
      const v = iou(s, gt);
      if (v > best.iou) {
        best = {
          iou: v,
          startErr: Math.abs(s.start - gt.start),
          endErr: Math.abs(s.end - gt.end),
        };
      }
    }
    return best;
  });
}

// ── Layer 4: highlight quality on originals ──────────────
const perSegment = [];
const perVideoSuggestions = new Map();
for (const video of manifest.videos) {
  const file = path.join(corpusDir, video.file);
  const suggestions = await suggest(file);
  perVideoSuggestions.set(video.file, suggestions);
  const scores = scoreAgainstGT(suggestions, video.groundTruth);
  perSegment.push(...scores);
  console.log(
    `${video.file}: ` +
      scores.map((s) => `IoU ${s.iou.toFixed(2)}`).join(", "),
  );
}

const hits = perSegment.filter((s) => s.iou >= 0.5);
const layer4 = {
  segments: perSegment.length,
  meanIoU: mean(perSegment.map((s) => s.iou)),
  hitRateAt50: hits.length / perSegment.length,
  startMAE: mean(hits.map((s) => s.startErr)),
  endMAE: mean(hits.map((s) => s.endErr)),
};
console.log("\n── Layer 4: highlight quality ──");
console.log(`  segments evaluated : ${layer4.segments}`);
console.log(`  mean temporal IoU  : ${layer4.meanIoU.toFixed(3)}`);
console.log(`  hit rate (IoU≥0.5) : ${(layer4.hitRateAt50 * 100).toFixed(0)}%`);
console.log(`  start MAE (hits)   : ${layer4.startMAE.toFixed(1)}s`);
console.log(`  end MAE (hits)     : ${layer4.endMAE.toFixed(1)}s`);

// ── Layer 3: robustness under transformations ────────────
const VARIANTS = [
  { id: "C01", label: "compress crf38", args: ["-c:v", "libx264", "-preset", "veryfast", "-crf", "38", "-c:a", "aac", "-b:a", "48k"], timeScale: 1 },
  { id: "S02", label: "resize 240p", args: ["-vf", "scale=426:240", "-c:a", "copy"], timeScale: 1 },
  { id: "E01", label: "brightness +25%", args: ["-vf", "eq=brightness=0.25", "-c:a", "copy"], timeScale: 1 },
  { id: "T01", label: "fps 30→15", args: ["-r", "15", "-c:a", "copy"], timeScale: 1 },
  { id: "T03", label: "speed 1.25x", args: ["-filter_complex", "[0:v]setpts=PTS/1.25[v];[0:a]atempo=1.25[a]", "-map", "[v]", "-map", "[a]"], timeScale: 1 / 1.25 },
];

let layer3 = null;
if (withVariants) {
  await mkdir(variantDir, { recursive: true });
  const rows = [];
  const subjects = manifest.videos.slice(0, 2); // 2 videos × 5 attacks
  for (const video of subjects) {
    const src = path.join(corpusDir, video.file);
    for (const v of VARIANTS) {
      const out = path.join(variantDir, `${video.file.replace(".mp4", "")}_${v.id}.mp4`);
      await execFileP("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", src, ...v.args, out]);
      const dur = DURATION * v.timeScale;
      const suggestions = await suggest(out, dur);
      // Ground truth re-timed for speed changes
      const gt = video.groundTruth.map((g) => ({ start: g.start * v.timeScale, end: g.end * v.timeScale }));
      const gtScores = scoreAgainstGT(suggestions, gt);
      // Stability: does the variant pick the same moments as the original?
      const origScaled = perVideoSuggestions
        .get(video.file)
        .map((s) => ({ start: s.start * v.timeScale, end: s.end * v.timeScale }));
      const stability = mean(origScaled.map((o) => Math.max(...suggestions.map((s) => iou(s, o)), 0)));
      rows.push({
        video: video.file,
        attack: v.label,
        gtIoU: mean(gtScores.map((s) => s.iou)),
        stability,
      });
      console.log(
        `${video.file} × ${v.label.padEnd(16)} GT-IoU ${mean(gtScores.map((s) => s.iou)).toFixed(2)}  stability ${stability.toFixed(2)}`,
      );
    }
  }
  layer3 = {};
  console.log("\n── Layer 3: robustness by attack ──");
  for (const v of VARIANTS) {
    const r = rows.filter((x) => x.attack === v.label);
    layer3[v.label] = { gtIoU: mean(r.map((x) => x.gtIoU)), stability: mean(r.map((x) => x.stability)) };
    console.log(
      `  ${v.label.padEnd(16)} GT-IoU ${layer3[v.label].gtIoU.toFixed(2)}  stability ${layer3[v.label].stability.toFixed(2)}`,
    );
  }
}

await writeFile(
  path.join(here, "eval-report.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), layer4, layer3 }, null, 2),
);
console.log("\nreport written to scripts/eval/eval-report.json");

function mean(xs) {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}
