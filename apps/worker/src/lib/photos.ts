import { spawn } from "child_process";
import { open, readFile, stat } from "fs/promises";
import { crc32 } from "zlib";
import { FFMPEG } from "../env";
import { killTree, track } from "./children";

/**
 * Video to photos: finding the shots, grabbing each still at full
 * quality, and bundling them into one ZIP.
 */

function runFfmpeg(
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = track(spawn(FFMPEG, args, { windowsHide: true, detached: true }));
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      killTree(child);
      reject(new Error(`ffmpeg timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 100_000) stderr = stderr.slice(-50_000);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to start ffmpeg: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve({ stdout, stderr })
        : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-300)}`));
    });
  });
}

/**
 * Scene cuts from ffmpeg's `metadata=print` output: each selected frame
 * prints a `pts_time:` line, then its `lavfi.scene_score=`.
 */
export function parseSceneMetadata(text: string): Array<{ time: number; score: number }> {
  const cuts: Array<{ time: number; score: number }> = [];
  let time: number | null = null;
  for (const line of text.split(/\r?\n/)) {
    const t = line.match(/pts_time:\s*([\d.]+)/);
    if (t?.[1]) {
      time = Number(t[1]);
      continue;
    }
    const s = line.match(/lavfi\.scene_score=([\d.]+)/);
    if (s?.[1] && time !== null) {
      cuts.push({ time, score: Number(s[1]) });
      time = null;
    }
  }
  return cuts;
}

/**
 * Where the picture changes to a new shot. Scanned at 4 frames a second
 * on a thumbnail-sized picture: a cut still stands out, and a two-hour
 * match scans in a minute or two.
 */
export async function detectSceneCuts(
  lowResPath: string,
  durationSeconds: number,
): Promise<Array<{ time: number; score: number }>> {
  const { stdout } = await runFfmpeg(
    [
      "-hide_banner", "-nostdin", "-loglevel", "error",
      "-i", lowResPath,
      "-an",
      "-vf", "fps=4,scale=160:-2,select='gt(scene\\,0.25)',metadata=print:file=-",
      "-f", "null", "-",
    ],
    Math.max(5 * 60_000, durationSeconds * 300),
  );
  return parseSceneMetadata(stdout);
}

/**
 * One full-quality still at `atSeconds`, read straight from the stream
 * URL: -ss before -i seeks by byte range, so only the few hundred KB
 * around that point are fetched. `thumbnail` looks at the next dozen
 * frames and keeps the most typical one, which steps past fades and
 * half-blended transition frames.
 */
export async function grabPhoto(
  streamUrl: string,
  atSeconds: number,
  outPath: string,
): Promise<void> {
  await runFfmpeg(
    [
      "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
      // Give up on a stalled read instead of hanging on it
      "-rw_timeout", "30000000",
      "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5",
      "-ss", atSeconds.toFixed(3),
      "-i", streamUrl,
      "-vf", "thumbnail=12",
      "-frames:v", "1",
      // Near the top of JPEG quality: these are photos to keep
      "-q:v", "2",
      outPath,
    ],
    // A healthy grab takes 5–10s; past this the read is stuck and a
    // fresh try does better than waiting
    45_000,
  );
  const { size } = await stat(outPath);
  if (size < 2048) throw new Error(`photo at ${atSeconds}s came out empty`);
}

/**
 * Writes an uncompressed ("stored") ZIP. JPEGs don't shrink under
 * deflate, and storing keeps this dependency-free and fast. Plain ZIP
 * limits apply (4 GB, 65k files) — far beyond a photo set.
 */
export async function writeStoreZip(
  files: Array<{ path: string; name: string }>,
  outPath: string,
): Promise<number> {
  const out = await open(outPath, "w");
  const central: Buffer[] = [];
  let offset = 0;
  const { time, date } = dosDateTime(new Date());
  try {
    for (const file of files) {
      const data = await readFile(file.path);
      const name = Buffer.from(file.name, "utf8");
      const crc = crc32(data);

      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4); // version needed
      local.writeUInt16LE(0x0800, 6); // UTF-8 names
      local.writeUInt16LE(0, 8); // stored
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);
      await out.write(local);
      await out.write(name);
      await out.write(data);

      const entry = Buffer.alloc(46);
      entry.writeUInt32LE(0x02014b50, 0);
      entry.writeUInt16LE(20, 4); // version made by
      entry.writeUInt16LE(20, 6);
      entry.writeUInt16LE(0x0800, 8);
      entry.writeUInt16LE(0, 10);
      entry.writeUInt16LE(time, 12);
      entry.writeUInt16LE(date, 14);
      entry.writeUInt32LE(crc, 16);
      entry.writeUInt32LE(data.length, 20);
      entry.writeUInt32LE(data.length, 24);
      entry.writeUInt16LE(name.length, 28);
      entry.writeUInt32LE(offset, 42);
      central.push(entry, name);
      offset += local.length + name.length + data.length;
    }

    const directory = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    await out.write(directory);
    await out.write(end);
    return offset + directory.length + end.length;
  } finally {
    await out.close();
  }
}

function dosDateTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}
