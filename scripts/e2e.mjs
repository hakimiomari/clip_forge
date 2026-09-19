/**
 * End-to-end pipeline test against a running ClipForge stack:
 * register → upload → import → generate highlights → create clip →
 * render → download → verify the MP4.
 *
 * Usage: node scripts/e2e.mjs [path-to-source-video]
 */
import { readFile, writeFile } from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";

const API = process.env.API_URL ?? "http://localhost:4000";
const sourcePath =
  process.argv[2] ?? path.join(import.meta.dirname, "e2e-assets", "e2e-source.mp4");
const execFileP = promisify(execFile);

const cookies = new Map();
function cookieHeader() {
  return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}
function storeCookies(res) {
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const [pair] = line.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
  }
}

async function api(pathName, { method = "GET", body } = {}) {
  const res = await fetch(`${API}${pathName}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      cookie: cookieHeader(),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  storeCookies(res);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${pathName} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : undefined;
}

async function poll(label, fn, { timeoutMs = 8 * 60_000, intervalMs = 4000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await fn();
    if (result.done) return result.value;
    if (result.failed) throw new Error(`${label} failed: ${result.failed}`);
    if (Date.now() > deadline) throw new Error(`${label} timed out`);
    process.stdout.write(`  ${label}: ${result.note ?? "waiting"}\n`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

const log = (msg) => console.log(`\n== ${msg}`);

// 1. Fresh account
log("Register");
const email = `e2e-${Date.now()}@clipforge.local`;
await api("/auth/register", {
  method: "POST",
  body: { name: "E2E Runner", email, password: "e2e-password-123" },
});
console.log(`  user: ${email}`);

// 2. Upload
log("Presign + upload source video");
const fileBytes = await readFile(sourcePath);
const presign = await api("/uploads/presign", {
  method: "POST",
  body: {
    fileName: path.basename(sourcePath),
    contentType: "video/mp4",
    sizeBytes: fileBytes.length,
  },
});
const putRes = await fetch(presign.uploadUrl, {
  method: "PUT",
  headers: { "content-type": "video/mp4" },
  body: fileBytes,
});
if (!putRes.ok) throw new Error(`Storage PUT failed: ${putRes.status}`);
console.log(`  uploaded ${(fileBytes.length / 1e6).toFixed(1)} MB`);

// 3. Project + import
log("Create project + import");
const project = await api("/projects", {
  method: "POST",
  body: { name: "E2E pipeline test" },
});
await api(`/projects/${project.id}/import`, {
  method: "POST",
  body: {
    sourceType: "UPLOAD",
    storageKey: presign.storageKey,
    rights: "OWNED",
    rightsConfirmed: true,
  },
});
await poll("import", async () => {
  const p = await api(`/projects/${project.id}`);
  if (p.status === "IMPORTED") return { done: true, value: p };
  if (p.status === "FAILED") return { failed: p.error };
  return { note: p.status };
});
console.log("  import complete");

// 4. Highlights
log("Generate highlights (30s x 3, heuristic unless AI key set)");
await api(`/projects/${project.id}/highlights/generate`, {
  method: "POST",
  body: {
    clipDuration: 30,
    clipCount: 3,
    format: "vertical",
    editingStyle: "dynamic_viral",
    captionStyle: "bold_dynamic",
  },
});
const ready = await poll("highlights", async () => {
  const p = await api(`/projects/${project.id}`);
  if (p.status === "READY") return { done: true, value: p };
  if (p.status === "FAILED") return { failed: p.error };
  return { note: p.status };
});
if (!ready.highlights?.length) throw new Error("No highlights generated");
console.log(`  ${ready.highlights.length} highlights:`);
for (const h of ready.highlights) {
  console.log(
    `   · [${h.score}] ${h.startTime}s–${h.endTime}s  "${h.title}" — ${h.reason?.slice(0, 70)}`,
  );
}

// 5. Clip + render
log("Create clip from top highlight (auto-renders)");
const clip = await api(`/highlights/${ready.highlights[0].id}/create-clip`, {
  method: "POST",
  body: {
    format: "vertical",
    captionsEnabled: true,
    captionStyle: "bold_dynamic",
    zoomEnabled: true,
  },
});
console.log(`  clip ${clip.id} status ${clip.status}`);
const rendered = await poll("render", async () => {
  const c = await api(`/clips/${clip.id}`);
  if (c.status === "RENDERED") return { done: true, value: c };
  if (c.status === "FAILED")
    return { failed: c.renderJob?.error ?? "unknown render error" };
  return { note: `${c.status} ${c.renderJob?.progress ?? 0}% ${c.renderJob?.step ?? ""}` };
});
console.log("  render complete");

// 6. Download + verify
log("Download final MP4");
const link = await api(`/clips/${clip.id}/download`);
const dl = await fetch(link.downloadUrl);
if (!dl.ok) throw new Error(`Download failed: ${dl.status}`);
const outPath = path.join(import.meta.dirname, "e2e-assets", "e2e-output.mp4");
await writeFile(outPath, Buffer.from(await dl.arrayBuffer()));
console.log(`  saved ${link.fileName} → ${outPath}`);

const { stdout } = await execFileP("ffprobe", [
  "-v", "error",
  "-print_format", "json",
  "-show_format", "-show_streams",
  outPath,
]);
const probe = JSON.parse(stdout);
const video = probe.streams.find((s) => s.codec_type === "video");
const audio = probe.streams.find((s) => s.codec_type === "audio");
const duration = Number(probe.format.duration);
console.log(
  `  verified: ${video.width}x${video.height} ${video.codec_name}, audio=${audio?.codec_name}, ${duration.toFixed(1)}s`,
);
if (video.width !== 1080 || video.height !== 1920) throw new Error("Wrong resolution");
if (!audio) throw new Error("Missing audio stream");
if (duration < 8) throw new Error("Suspiciously short output");

console.log("\n✅ E2E PIPELINE PASSED — upload → highlights → clip → render → download");
