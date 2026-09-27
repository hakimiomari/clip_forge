import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CAMERA_DIRECTIONS,
  MAX_GENERATED_SHOTS,
  pickGeneratedEngine,
  planShots,
} from "@clipforge/shared-types";

test("pickGeneratedEngine: a real video model when a key exists, else the free engine", () => {
  assert.equal(pickGeneratedEngine({}), "images");
  assert.equal(pickGeneratedEngine({ OPENAI_API_KEY: "sk-x" }), "sora");
  // Veo wins when both keys are present
  assert.equal(pickGeneratedEngine({ OPENAI_API_KEY: "sk-x", GEMINI_API_KEY: "g" }), "veo");
  // An explicit choice overrides the keys
  assert.equal(pickGeneratedEngine({ GEMINI_API_KEY: "g", VIDEO_ENGINE: "images" }), "images");
  // Blank values don't count as keys
  assert.equal(pickGeneratedEngine({ GEMINI_API_KEY: "  " }), "images");
});

test("planShots splits the length into the engine's shot size", () => {
  // Veo makes 8s shots: a 16s video is two of them
  assert.equal(planShots("a cat", 16, "veo", "cinematic").length, 2);
  // The free engine holds a picture for 4s: a 16s video is four
  assert.equal(planShots("a cat", 16, "images", "cinematic").length, 4);
  // Never fewer than one, never more than the cap
  assert.equal(planShots("a cat", 2, "veo", "cinematic").length, 1);
  assert.equal(planShots("a cat", 600, "images", "cinematic").length, MAX_GENERATED_SHOTS);
});

test("planShots gives every shot its own camera direction and the chosen look", () => {
  const shots = planShots("A person in a VR headset.", 12, "images", "anime");
  assert.equal(shots.length, 3);
  shots.forEach((shot, i) => {
    assert.equal(shot.index, i);
    assert.equal(shot.seconds, 4);
    assert.match(shot.prompt, /^A person in a VR headset\. /);
    assert.ok(shot.prompt.includes(CAMERA_DIRECTIONS[i]!), `shot ${i} has a camera direction`);
    assert.match(shot.prompt, /studio ghibli/);
  });
  assert.notEqual(shots[0]!.prompt, shots[1]!.prompt);
});
