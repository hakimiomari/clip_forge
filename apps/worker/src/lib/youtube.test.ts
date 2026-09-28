import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJson3Captions, pickCaptionTrack } from "./youtube";

test("pickCaptionTrack prefers uploaded English, then any uploaded, then ASR original", () => {
  assert.deepEqual(pickCaptionTrack(["de", "en"], ["en"]), { lang: "en", auto: false });
  assert.deepEqual(pickCaptionTrack(["de"], ["en"]), { lang: "de", auto: false });
  assert.deepEqual(pickCaptionTrack([], ["fr", "es-orig", "en"]), { lang: "es-orig", auto: true });
  assert.deepEqual(pickCaptionTrack([], ["fr", "en"]), { lang: "en", auto: true });
  assert.deepEqual(pickCaptionTrack(["live_chat"], []), null);
});

test("parseJson3Captions turns events into trimmed, timed segments", () => {
  const raw = JSON.stringify({
    events: [
      { tStartMs: 0, dDurationMs: 0, id: 1 }, // header event, no segs
      { tStartMs: 1200, dDurationMs: 2160, segs: [{ utf8: "All right, so here we are,\nin front" }] },
      { tStartMs: 3360, dDurationMs: 100, aAppend: 1, segs: [{ utf8: "\n" }] },
      { tStartMs: 5318, dDurationMs: 2656, segs: [{ utf8: "the cool " }, { utf8: "thing" }] },
      { tStartMs: 9000, dDurationMs: 500, segs: [{ utf8: "  " }] },
    ],
  });
  assert.deepEqual(parseJson3Captions(raw), [
    { startTime: 1.2, endTime: 3.36, text: "All right, so here we are, in front" },
    { startTime: 5.318, endTime: 7.974, text: "the cool thing" },
  ]);
});

test("parseFullDownloadProgress weights the video track, then the audio", async () => {
  const { parseFullDownloadProgress } = await import("./youtube");
  assert.equal(parseFullDownloadProgress("[download] Destination: x.f137.mp4"), null);
  assert.equal(parseFullDownloadProgress("CFPROGRESS avc1.640028   0.0%"), 0);
  // Halfway through the video track is 46% overall
  assert.equal(parseFullDownloadProgress("CFPROGRESS avc1.640028  50.0%"), 0.46);
  // The audio track starts where the video left off
  assert.equal(parseFullDownloadProgress("CFPROGRESS none   0.0%"), 0.92);
  assert.equal(parseFullDownloadProgress("CFPROGRESS none 100.0%"), 1);
});

test("parseFullDownloadProgress: an audio-only download is its own percentage", async () => {
  const { parseFullDownloadProgress } = await import("./youtube");
  assert.equal(parseFullDownloadProgress("CFPROGRESS none  40.0%", true), 0.4);
});

test("fullVideoFormat caps the height and prefers H.264", async () => {
  const { fullVideoFormat } = await import("./youtube");
  assert.match(fullVideoFormat("720p"), /^bv\*\[height<=720\]\[vcodec\^=avc1\]\+ba\[ext=m4a\]/);
  assert.ok(!fullVideoFormat("480p").includes("1080"));
  assert.equal(fullVideoFormat("audio"), "ba[ext=m4a]/ba");
});
