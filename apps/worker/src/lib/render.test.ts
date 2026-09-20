import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFilterGraph,
  buildRenderArgs,
  escapeFilterPath,
  type RenderSpec,
} from "./render";

const baseSpec: RenderSpec = {
  inputPath: "C:\\tmp\\in.mp4",
  outputPath: "C:\\tmp\\out.mp4",
  sourceStart: 12,
  sourceEnd: 72,
  width: 1080,
  height: 1920,
  blurBackground: true,
  zoom: true,
  hasAudio: true,
};

void test("escapeFilterPath handles Windows paths", () => {
  assert.equal(
    escapeFilterPath("C:\\Users\\Test User\\cap.ass"),
    "C\\:/Users/Test User/cap.ass",
  );
});

void test("filtergraph includes blur background, zoom, fades and loudnorm", () => {
  const graph = buildFilterGraph(baseSpec);
  assert.match(graph, /boxblur/);
  assert.match(graph, /overlay=\(W-w\)\/2:\(H-h\)\/2/);
  assert.match(graph, /zoompan/);
  assert.match(graph, /fade=t=in/);
  assert.match(graph, /fade=t=out:st=59\.55/); // 60s clip → fade near the end
  assert.match(graph, /loudnorm/);
  assert.match(graph, /\[vout\]/);
  assert.match(graph, /\[aout\]/);
});

void test("filtergraph burns subtitles when an ASS path is set", () => {
  const graph = buildFilterGraph({
    ...baseSpec,
    assPath: "C:\\work\\captions.ass",
  });
  assert.match(graph, /subtitles=filename='C\\:\/work\/captions\.ass'/);
});

void test("pad mode used when blur background disabled", () => {
  const graph = buildFilterGraph({ ...baseSpec, blurBackground: false, zoom: false });
  assert.match(graph, /pad=1080:1920/);
  assert.doesNotMatch(graph, /zoompan/);
});

void test("render args seek, bound input read and map streams", () => {
  const args = buildRenderArgs(baseSpec);
  const joined = args.join(" ");
  // -t must be an INPUT option (before -i) so speed effects can lengthen
  // the output beyond the source window
  assert.match(joined, /-ss 12\.000 -t 60\.000 -i C:\\tmp\\in\.mp4/);
  assert.match(joined, /-map \[vout\] -map \[aout\]/);
  assert.match(joined, /-c:v libx264/);
  assert.match(joined, /\+faststart/);
});

void test("output duration is not capped when speed effects lengthen the clip", () => {
  const args = buildRenderArgs({
    ...baseSpec,
    rangeEffects: [
      { id: "s", type: "slow_motion", start: 10, end: 20, factor: 0.5 },
    ],
  });
  // No output-side -t: nothing between the last input and the output path
  // may cap the duration
  const iIdx = args.indexOf("-i");
  assert.ok(!args.slice(iIdx).includes("-t"), "-t must not appear after -i");
});

void test("audio omitted for silent sources", () => {
  const args = buildRenderArgs({ ...baseSpec, hasAudio: false });
  assert.ok(args.includes("-an"));
  assert.ok(!args.join(" ").includes("[aout]"));
});
