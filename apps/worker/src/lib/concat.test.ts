import { test } from "node:test";
import assert from "node:assert/strict";
import { buildConcatArgs, type ConcatPart } from "./concat";

const parts: ConcatPart[] = [
  { inputPath: "/tmp/source.mp4", start: 12.5, duration: 6 },
  { inputPath: "/tmp/source.mp4", start: 90, duration: 4.25 },
];

test("each part is seeked before its input, not decoded from zero", () => {
  const args = buildConcatArgs(parts, "/tmp/out.mp4", { hasAudio: true });
  const joined = args.join(" ");
  // -ss and -t must precede their -i to make ffmpeg seek the input
  assert.match(joined, /-ss 12\.500 -t 6\.000 -i \/tmp\/source\.mp4/);
  assert.match(joined, /-ss 90\.000 -t 4\.250 -i \/tmp\/source\.mp4/);
  assert.equal(args.filter((a) => a === "-i").length, 2);
});

test("streams are normalised and concatenated with audio", () => {
  const graph = buildConcatArgs(parts, "/tmp/out.mp4", { hasAudio: true, fps: 25 })[
    buildConcatArgs(parts, "/tmp/out.mp4", { hasAudio: true, fps: 25 }).indexOf("-filter_complex") + 1
  ]!;
  assert.match(graph, /\[0:v\]fps=25,setsar=1,setpts=PTS-STARTPTS\[cv0\]/);
  assert.match(graph, /\[1:a\]aformat=sample_rates=48000/);
  assert.match(graph, /\[cv0\]\[ca0\]\[cv1\]\[ca1\]concat=n=2:v=1:a=1\[cvout\]\[caout\]/);
});

test("a silent source concatenates video only", () => {
  const args = buildConcatArgs(parts, "/tmp/out.mp4", { hasAudio: false });
  const graph = args[args.indexOf("-filter_complex") + 1]!;
  assert.match(graph, /concat=n=2:v=1:a=0\[cvout\]/);
  assert.ok(!graph.includes("aformat"), "no audio chains");
  assert.ok(args.includes("-an"), "output has no audio stream");
});

test("refuses to build a join for fewer than two parts", () => {
  assert.throws(
    () => buildConcatArgs([parts[0]!], "/tmp/out.mp4", { hasAudio: true }),
    /at least two parts/,
  );
});

test("parts of different sizes are fitted to one frame size", () => {
  const args = buildConcatArgs(parts, "/tmp/out.mp4", {
    hasAudio: true,
    size: { width: 1280, height: 720 },
  });
  const graph = args[args.indexOf("-filter_complex") + 1]!;
  assert.match(
    graph,
    /\[1:v\]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:\(ow-iw\)\/2:\(oh-ih\)\/2,fps=30/,
  );
});
