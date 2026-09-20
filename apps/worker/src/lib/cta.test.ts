import test from "node:test";
import assert from "node:assert/strict";
import { buildCtaAss, ctaWindow } from "./cta";

void test("ctaWindow presets land where expected", () => {
  assert.deepEqual(ctaWindow("start", 60), { start: 0.8, end: 5.8 });
  const mid = ctaWindow("middle", 60);
  assert.ok(mid.start >= 23 && mid.end <= 29);
  const end = ctaWindow("end", 60);
  assert.ok(end.start === 54 && end.end === 59.2);
  const always = ctaWindow("always", 60);
  assert.ok(always.start < 1 && always.end > 59);
});

void test("ctaWindow custom clamps to the clip", () => {
  assert.deepEqual(
    ctaWindow("custom", 60, { start: 40, end: 55 }),
    { start: 40, end: 55 },
  );
  // Out-of-range values clamp instead of failing
  const clamped = ctaWindow("custom", 30, { start: 50, end: 90 });
  assert.ok(clamped.start <= 29.5 && clamped.end <= 30);
  assert.ok(clamped.end > clamped.start);
});

void test("buildCtaAss renders texts, position and window", () => {
  const doc = buildCtaAss(
    {
      enabled: true,
      likeText: "like",
      followText: "subscribe",
      timing: "custom",
      customStart: 40,
      customEnd: 55,
      position: "bottom",
    },
    { width: 1080, height: 1920, outputDuration: 60 },
  );
  assert.match(doc, /LIKE/);
  assert.match(doc, /SUBSCRIBE/);
  assert.match(doc, /♥/);
  assert.match(doc, /Dialogue: 1,0:00:40\.00,0:00:55\.00,Cta/);
  // bottom position → alignment 2
  assert.match(doc, /,2,60,60,\d+,1\s*$/m);
  // braces in user text are neutralized
  const evil = buildCtaAss(
    {
      enabled: true,
      likeText: "{\\b1}x",
      followText: "f",
      timing: "middle",
      position: "top",
    },
    { width: 1080, height: 1920, outputDuration: 60 },
  );
  assert.doesNotMatch(evil, /\{\\B1\}X/);
});
