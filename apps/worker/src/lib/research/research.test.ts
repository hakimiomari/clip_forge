import { test } from "node:test";
import assert from "node:assert/strict";
import {
  estimateSpokenSeconds,
  splitIntoScenes,
  MAX_SCENE_SECONDS,
  MIN_SCENE_SECONDS,
} from "@clipforge/shared-types";
import { stripHtml } from "./sources";
import { buildAttribution, buildResearchPlan } from "./plan";

const article = {
  title: "Cricket World Cup",
  url: "https://en.wikipedia.org/wiki/Cricket_World_Cup",
  summary:
    "The ICC Men's Cricket World Cup is a quadrennial world cup for cricket in One Day International format. " +
    "The tournament is one of the world's most viewed sporting events and the flagship of the calendar.",
  body:
    "The first World Cup was played in England in June 1975 with eight teams taking part in the tournament. " +
    "Australia have won the trophy more times than any other nation across the history of the competition.",
};

test("wiki plumbing never becomes a narrated scene", () => {
  const polluted =
    "%5B%5BWikipedia%3ATemplates+for+discussion%2FLog%2F2025+December+5%23Template%3ASeason+sidebar%5D%5D. " +
    "This is an ordinary sentence about the tournament that should survive the filter. " +
    "See Template:Season sidebar for the navigation box used across these articles. " +
    "More detail is available at https://example.com/some/page which is not worth reading aloud.";
  const scenes = splitIntoScenes(polluted, 10);
  assert.equal(scenes.length, 1);
  assert.match(scenes[0]!, /ordinary sentence about the tournament/);
});

test("removing an aside does not leave a gap before the punctuation", () => {
  const scenes = splitIntoScenes(
    "The tournament is organised by the International Cricket Council (ICC). " +
      "It has been held every four years since nineteen seventy five in England.",
    5,
  );
  assert.ok(scenes.length >= 1);
  assert.ok(!scenes.some((s) => / [.,;:!?]/.test(s)), scenes.join(" | "));
  assert.match(scenes[0]!, /International Cricket Council\.$/);
});

test("scene sentences are long enough to matter, short enough to say", () => {
  const scenes = splitIntoScenes(article.summary + " " + article.body, 10);
  assert.ok(scenes.length >= 3, `got ${scenes.length}`);
  for (const scene of scenes) {
    assert.ok(scene.length >= 40 && scene.length <= 220, scene);
  }
});

test("spoken length is bounded and grows with the sentence", () => {
  const short = estimateSpokenSeconds("A short line about cricket.");
  const long = estimateSpokenSeconds(
    "The tournament is one of the world's most viewed sporting events and is considered the flagship event of the international cricket calendar.",
  );
  assert.ok(long > short);
  assert.ok(short >= MIN_SCENE_SECONDS);
  assert.ok(long <= MAX_SCENE_SECONDS);
});

test("a plan pairs every sentence with media and credits each source", () => {
  const images = [
    {
      kind: "image" as const,
      sourceUrl: "https://commons.example/a.jpg",
      pageUrl: "https://commons.example/File:a.jpg",
      title: "Stadium.jpg",
      license: "CC BY-SA 4.0",
      author: "Photographer",
    },
  ];
  const videos = [
    {
      kind: "video" as const,
      sourceUrl: "https://commons.example/b.webm",
      title: "Fireworks.webm",
      license: "CC BY 3.0",
      author: "Someone",
    },
  ];
  const plan = buildResearchPlan({ article, images, videos, maxScenes: 4 });

  assert.ok(plan.scenes.length > 0);
  // Video first: scarce footage is spent where it holds attention
  assert.equal(plan.scenes[0]!.media?.kind, "video");
  for (const scene of plan.scenes) {
    assert.ok(scene.media, "every scene has something on screen");
    assert.ok(scene.seconds >= MIN_SCENE_SECONDS);
  }

  const credits = buildAttribution(plan);
  assert.match(credits, /en\.wikipedia\.org\/wiki\/Cricket_World_Cup/);
  assert.match(credits, /Fireworks\.webm — Someone \(CC BY 3\.0\)/);
  assert.match(credits, /Stadium\.jpg — Photographer \(CC BY-SA 4\.0\)/);
});

test("scenes still build when no media was found", () => {
  const plan = buildResearchPlan({ article, images: [], videos: [], maxScenes: 3 });
  assert.ok(plan.scenes.length > 0);
  assert.equal(plan.scenes[0]!.media, null);
});

test("Commons attribution HTML is reduced to plain text", () => {
  assert.equal(
    stripHtml('<a href="https://commons.wikimedia.org/wiki/User:Bob">Bob</a>'),
    "Bob",
  );
  assert.equal(stripHtml(undefined), "");
});
