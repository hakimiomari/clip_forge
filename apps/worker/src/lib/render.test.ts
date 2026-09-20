import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAudioFxChain,
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
  // Blur runs at quarter resolution, then upscales to full frame
  assert.match(graph, /scale=270:480:force_original_aspect_ratio=increase/);
  assert.match(graph, /overlay=\(W-w\)\/2:\(H-h\)\/2/);
  // Zoom is per-frame scale+crop (zoompan was an order of magnitude slower)
  assert.match(graph, /eval=frame,crop=1080:1920\[vzoom\]/);
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
  assert.doesNotMatch(graph, /vzoom/);
});

void test("fill mode covers the frame with a center crop and no bars", () => {
  const graph = buildFilterGraph({ ...baseSpec, fillFrame: true, zoom: false });
  assert.match(
    graph,
    /scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920\[vbase\]/,
  );
  assert.doesNotMatch(graph, /boxblur/);
  assert.doesNotMatch(graph, /pad=/);
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

void test("audio fx chain: volume, pitch, EQ, effects", () => {
  assert.equal(buildAudioFxChain(undefined), "");
  assert.equal(buildAudioFxChain({ originalVolume: 1 }), "");
  assert.match(buildAudioFxChain({ originalVolume: 2 }), /^volume=2\.00,/);
  // +12 semitones = 2x rate, undone by atempo 0.5 (duration preserved)
  const pitchUp = buildAudioFxChain({ pitchSemitones: 12 });
  assert.match(pitchUp, /asetrate=48000\*2\.00000/);
  assert.match(pitchUp, /atempo=0\.50000/);
  const deep = buildAudioFxChain({ pitchSemitones: -12 });
  assert.match(deep, /asetrate=48000\*0\.50000/);
  assert.match(deep, /atempo=2\.00000/);
  assert.match(buildAudioFxChain({ noiseReduction: true }), /afftdn/);
  assert.match(buildAudioFxChain({ voiceEnhance: true }), /acompressor/);
  assert.match(buildAudioFxChain({ bassGain: 6 }), /bass=g=6\.0/);
  assert.match(buildAudioFxChain({ voiceEffect: "telephone" }), /highpass=f=300,lowpass=f=3400/);
  assert.match(buildAudioFxChain({ voiceEffect: "robot" }), /afftfilt/);
});

void test("audio tail honors fx, fade and normalize settings", () => {
  const graph = buildFilterGraph({
    ...baseSpec,
    audio: {
      originalVolume: 2,
      pitchSemitones: -5,
      voiceEffect: "echo",
      normalize: false,
      fadeIn: false,
      fadeOut: true,
    },
  });
  assert.match(graph, /volume=2\.00/);
  assert.match(graph, /aecho/);
  assert.doesNotMatch(graph, /loudnorm/);
  assert.doesNotMatch(graph, /afade=t=in/);
  assert.match(graph, /afade=t=out/);
});

void test("render args bound thread counts to limit memory", () => {
  const joined = buildRenderArgs(baseSpec).join(" ");
  assert.match(joined, /-filter_complex_threads 2/);
  assert.match(joined, /-threads 2/);
  assert.match(joined, /sync-lookahead=0/);
  // Low-memory retry drops to a single thread
  const single = buildRenderArgs({ ...baseSpec, threads: 1 }).join(" ");
  assert.match(single, /-filter_complex_threads 1/);
  assert.match(single, /-threads 1/);
});

void test("audio omitted for silent sources", () => {
  const args = buildRenderArgs({ ...baseSpec, hasAudio: false });
  assert.ok(args.includes("-an"));
  assert.ok(!args.join(" ").includes("[aout]"));
});
