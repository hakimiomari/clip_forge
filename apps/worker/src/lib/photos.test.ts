import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { evenPhotoTimes, photoStamp, pickSceneTimes } from "@clipforge/shared-types";
import { parseSceneMetadata, writeStoreZip } from "./photos";

test("evenPhotoTimes spreads photos across the video, clear of the ends", () => {
  const times = evenPhotoTimes(600, 12);
  assert.equal(times.length, 12);
  // 3% of a 10-minute video (18s) is capped at 15s at each end
  assert.ok(times[0]! > 15 && times.at(-1)! < 585);
  const gaps = times.slice(1).map((t, i) => t - times[i]!);
  assert.ok(Math.max(...gaps) - Math.min(...gaps) < 0.2, "evenly spaced");
});

test("pickSceneTimes: strongest cut per slice, a moment after it; middle when a slice has none", () => {
  const cuts = [
    { time: 30, score: 0.3 },
    { time: 60, score: 0.9 }, // beats 30s in the first slice
    { time: 250, score: 0.5 },
  ];
  const times = pickSceneTimes(cuts, 300, 3, 1);
  assert.equal(times.length, 3);
  assert.equal(times[0], 61);
  // Middle slice has no cut: its midpoint is used, so it is still covered
  assert.equal(times[1], 150);
  assert.equal(times[2], 251);
});

test("parseSceneMetadata pairs each frame time with its scene score", () => {
  const text = [
    "frame:0    pts:4096   pts_time:12.5",
    "lavfi.scene_score=0.412",
    "frame:1    pts:9000   pts_time:44.25",
    "lavfi.scene_score=0.9",
  ].join("\n");
  assert.deepEqual(parseSceneMetadata(text), [
    { time: 12.5, score: 0.412 },
    { time: 44.25, score: 0.9 },
  ]);
});

test("photoStamp names a time for a file", () => {
  assert.equal(photoStamp(754), "12m34s");
  assert.equal(photoStamp(3725), "1h02m05s");
});

test("writeStoreZip builds a ZIP that unzip accepts, contents intact", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "zip-test-"));
  try {
    writeFileSync(path.join(dir, "a.bin"), Buffer.from("first photo"));
    writeFileSync(path.join(dir, "b.bin"), Buffer.alloc(5000, 7));
    const zip = path.join(dir, "out.zip");
    const bytes = await writeStoreZip(
      [
        { path: path.join(dir, "a.bin"), name: "01 - 00m15s.jpg" },
        { path: path.join(dir, "b.bin"), name: "02 - 01m30s.jpg" },
      ],
      zip,
    );
    assert.equal(bytes, readFileSync(zip).length);
    // The system unzip checks every CRC with -t
    assert.match(execFileSync("unzip", ["-t", zip]).toString(), /No errors detected/);
    const out = path.join(dir, "x");
    execFileSync("unzip", ["-q", zip, "-d", out]);
    assert.equal(readFileSync(path.join(out, "01 - 00m15s.jpg"), "utf8"), "first photo");
    assert.equal(readFileSync(path.join(out, "02 - 01m30s.jpg")).length, 5000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
