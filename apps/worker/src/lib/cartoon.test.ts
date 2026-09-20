import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CARTOON_LONG_EDGE,
  fromModelValue,
  modelDimensions,
  toModelValue,
} from "./cartoon";

test("pixels round-trip through the model's [-1,1] range", () => {
  for (const byte of [0, 1, 64, 127, 128, 200, 255]) {
    assert.equal(fromModelValue(toModelValue(byte)), byte, `byte ${byte}`);
  }
  assert.equal(toModelValue(0), -1);
  assert.equal(toModelValue(255), 1);
});

test("model output is clamped to a valid byte", () => {
  // The network can overshoot slightly past ±1
  assert.equal(fromModelValue(-1.4), 0);
  assert.equal(fromModelValue(1.6), 255);
});

test("model dimensions keep aspect and land on multiples of 8", () => {
  const landscape = modelDimensions(1920, 1080, 512);
  assert.equal(landscape.width, 512);
  assert.equal(landscape.width % 8, 0);
  assert.equal(landscape.height % 8, 0);
  // 16:9 stays close to 16:9
  assert.ok(Math.abs(landscape.width / landscape.height - 16 / 9) < 0.05);

  const vertical = modelDimensions(720, 1280, 512);
  assert.equal(vertical.height, 512, "long edge is the height here");
  assert.equal(vertical.width % 8, 0);

  // Tiny sources never collapse to zero
  const tiny = modelDimensions(32, 8, 512);
  assert.ok(tiny.width >= 8 && tiny.height >= 8);
});

test("a small source is never enlarged before stylizing", () => {
  // 360p source asked for a 1080 long edge stays at its own size: the
  // model can't invent detail, and the extra pixels cost real time
  const small = modelDimensions(640, 360, 1080);
  assert.equal(small.width, 640);
  assert.equal(small.height, 360);
});

test("a larger source is scaled down to the requested long edge", () => {
  // 720p and 4K sources both land on the export's 1080 long edge
  assert.equal(modelDimensions(1280, 720, 1080).width, 1080);
  assert.equal(modelDimensions(3840, 2160, 1080).width, 1080);
});

test("high quality asks for a bigger long edge than standard", () => {
  assert.ok(CARTOON_LONG_EDGE.high > CARTOON_LONG_EDGE.standard);
  assert.equal(CARTOON_LONG_EDGE.standard, 512);
});

test("high quality reaches a landscape export's full width", () => {
  // 1920-wide export with a 1280 source: stylize at the source's own
  // size rather than the 1080 a vertical export would ask for
  const target = Math.min(CARTOON_LONG_EDGE.high, 1920);
  assert.equal(modelDimensions(1280, 720, target).width, 1280);
});
