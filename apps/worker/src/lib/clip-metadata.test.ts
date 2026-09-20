import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildClipDescription,
  buildClipTitle,
  buildHashtags,
} from "@clipforge/shared-types";

const cricket = {
  sourceTitle: "Full Match Highlights | Afghanistan vs India | Match 03 | T20I Series 2026",
  sourceUrl: "https://www.youtube.com/watch?v=zQfg-e3QORc",
  parts: [{ start: 303, end: 309 }],
  spokenLines: ["that is a magnificent shot", "straight back over the bowler's head"],
  highlightTitle: "Magnificent shot over the bowler",
};

test("the title prefers what the user named the clip", () => {
  assert.equal(
    buildClipTitle({ ...cricket, clipName: "Abhishek's six" }),
    "Abhishek's six",
  );
});

test("the title falls back through highlight, speech, then source", () => {
  assert.equal(buildClipTitle(cricket), "Magnificent shot over the bowler");
  assert.equal(
    buildClipTitle({ ...cricket, highlightTitle: null }),
    "that is a magnificent shot",
  );
  // "Clip" is the placeholder name, not a real title
  assert.equal(
    buildClipTitle({ ...cricket, clipName: "Clip", highlightTitle: null, spokenLines: [] }),
    "Full Match Highlights | Afghanistan vs India | Match 03 | T20I Series 2026 — 5:03",
  );
});

test("the title stays within the 100-character platform limit", () => {
  const title = buildClipTitle({
    ...cricket,
    clipName: "x".repeat(300),
  });
  assert.ok(title.length <= 96, `was ${title.length}`);
  assert.ok(title.endsWith("…"));
});

test("the description quotes what is actually said and cites the source", () => {
  const description = buildClipDescription(cricket);
  assert.match(description, /"that is a magnificent shot straight back over the bowler's head"/);
  assert.match(description, /From: Full Match Highlights/);
  assert.match(description, /Moment: 5:03–5:09 of the full video/);
  assert.match(description, /Full video: https:\/\/www\.youtube\.com/);
});

test("a stitched clip lists every moment it used", () => {
  const description = buildClipDescription({
    ...cricket,
    parts: [
      { start: 30, end: 36 },
      { start: 300, end: 308 },
    ],
  });
  assert.match(description, /Moments used: 0:30–0:36, 5:00–5:08/);
});

test("sections with no data are left out, not padded", () => {
  // An upload with no transcript and no source link
  const description = buildClipDescription({
    sourceTitle: null,
    sourceUrl: null,
    parts: [{ start: 0, end: 10 }],
    spokenLines: [],
  });
  assert.ok(!description.includes("From:"));
  assert.ok(!description.includes("Full video:"));
  assert.ok(!description.includes('""'), "no empty quote block");
  assert.match(description, /Moment: 0:00–0:10/);
});

test("hashtags come from real words in the source title", () => {
  const tags = buildHashtags(cricket.sourceTitle);
  assert.ok(tags.includes("#afghanistan"));
  assert.ok(tags.includes("#india"));
  // Generic filler and bare numbers are skipped
  assert.ok(!tags.includes("#full"));
  assert.ok(!tags.includes("#match"));
  assert.ok(!tags.includes("#03"));
  assert.ok(tags.length <= 6);
  assert.deepEqual(buildHashtags(null), []);
});

test("an hour-long source formats timestamps with hours", () => {
  const description = buildClipDescription({
    ...cricket,
    parts: [{ start: 3725, end: 3735 }],
  });
  assert.match(description, /1:02:05–1:02:15/);
});
