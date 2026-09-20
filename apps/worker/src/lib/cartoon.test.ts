import { test } from "node:test";
import assert from "node:assert/strict";
import { fromModelValue, modelDimensions, toModelValue } from "./cartoon";

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
