import test from "node:test";
import assert from "node:assert/strict";
import {
  assTime,
  buildAssDocument,
  escapeAssText,
  splitCaption,
} from "./captions";

void test("assTime formats centisecond timestamps", () => {
  assert.equal(assTime(0), "0:00:00.00");
  assert.equal(assTime(61.25), "0:01:01.25");
  assert.equal(assTime(3723.5), "1:02:03.50");
});

void test("splitCaption chunks long sentences proportionally", () => {
  const chunks = splitCaption(
    { startTime: 0, endTime: 8, text: "one two three four five six seven eight" },
    4,
  );
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0]!.startTime, 0);
  assert.ok(Math.abs(chunks[0]!.endTime - 4) < 0.01);
  assert.ok(Math.abs(chunks[1]!.endTime - 8) < 0.01);
  assert.equal(chunks[1]!.text, "five six seven eight");
});

void test("escapeAssText neutralizes override braces and newlines", () => {
  assert.equal(escapeAssText("{\\b1}hi\nthere"), "(\\b1)hi\\Nthere");
});

void test("buildAssDocument produces a valid styled document", () => {
  const doc = buildAssDocument(
    [
      { startTime: 0.5, endTime: 2.5, text: "Hello world" },
      { startTime: 2.5, endTime: 4.0, text: "this is clipforge" },
    ],
    { style: "bold_dynamic", position: "center", width: 1080, height: 1920 },
  );
  assert.match(doc, /PlayResX: 1080/);
  assert.match(doc, /PlayResY: 1920/);
  assert.match(doc, /Style: Caption,Arial/);
  // bold_dynamic uppercases
  assert.match(doc, /HELLO WORLD/);
  assert.match(doc, /Dialogue: 0,0:00:00\.50,0:00:02\.50,Caption/);
});

void test("buildAssDocument falls back to bold style for unknown names", () => {
  const doc = buildAssDocument(
    [{ startTime: 0, endTime: 1, text: "test" }],
    { style: "does_not_exist", position: "bottom", width: 1080, height: 1080 },
  );
  assert.match(doc, /Style: Caption,Arial/);
});
