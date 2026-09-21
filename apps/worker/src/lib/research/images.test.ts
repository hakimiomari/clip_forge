import test from "node:test";
import assert from "node:assert/strict";
import { buildImagePrompt, GENERATED_SIZES } from "./images";

void test("prompt keeps the visual clause and drops encyclopedia noise", () => {
  const prompt = buildImagePrompt(
    "Mount Fuji",
    "Mount Fuji is an active stratovolcano that last erupted from 1707 to 1708 [3], and it is the tallest mountain in Japan.",
  );
  assert.match(prompt, /^Mount Fuji\. /);
  assert.match(prompt, /stratovolcano/);
  // Years and citation markers describe facts, not pictures
  assert.doesNotMatch(prompt, /1707|1708|\[3\]/);
  assert.match(prompt, /anime illustration/);
});

void test("stripping dates does not strand the words that introduced them", () => {
  const prompt = buildImagePrompt(
    "Mount Fuji",
    "Mount Fuji last erupted from 1707 to 1708 and has been quiet since.",
  );
  // The old version produced "last erupted from to .."
  assert.doesNotMatch(prompt, /from to|between and|\.\s*\./);
  assert.doesNotMatch(prompt, /\s+\./);
  assert.match(prompt, /erupted/);
});

void test("a sentence that is only dates falls back to the topic", () => {
  const prompt = buildImagePrompt("Mount Fuji", "From 1707 to 1708.");
  assert.equal(prompt.startsWith("Mount Fuji. anime illustration"), true);
});

void test("a short first clause falls back to the fuller sentence", () => {
  const prompt = buildImagePrompt(
    "Cherry blossom",
    "In Japan, cherry blossoms symbolise the fleeting nature of life and draw crowds each spring.",
  );
  // "In Japan" alone would draw nothing useful
  assert.match(prompt, /symbolise|fleeting|crowds/);
});

void test("prompt is bounded so the URL stays sane", () => {
  const long = "A ".repeat(400) + "very long sentence about a mountain.";
  const prompt = buildImagePrompt("Topic", long);
  assert.ok(prompt.length < 400, `prompt was ${prompt.length} chars`);
});

void test("generated sizes match each format's aspect", () => {
  assert.ok(GENERATED_SIZES.vertical.height > GENERATED_SIZES.vertical.width);
  assert.ok(GENERATED_SIZES.landscape.width > GENERATED_SIZES.landscape.height);
  assert.equal(GENERATED_SIZES.square.width, GENERATED_SIZES.square.height);
});
