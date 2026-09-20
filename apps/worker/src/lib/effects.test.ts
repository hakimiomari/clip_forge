import test from "node:test";
import assert from "node:assert/strict";
import {
  atempoChain,
  buildGatedEffects,
  buildGlowTrail,
  buildPathExpression,
  buildSpeedChain,
} from "./effects";
import { buildTimeMap } from "./time-map";

void test("atempoChain stays within filter limits", () => {
  assert.equal(atempoChain(0.5), "atempo=0.5000");
  assert.equal(atempoChain(0.25), "atempo=0.5,atempo=0.5000");
  assert.equal(atempoChain(3), "atempo=2.0,atempo=1.5000");
});

void test("speed chain builds trim/setpts segments and concat", () => {
  const map = buildTimeMap(
    [{ id: "a", type: "slow_motion", start: 10, end: 13, factor: 0.5 }],
    30,
  );
  const { chains, vOut, aOut } = buildSpeedChain(map, true);
  const graph = chains.join(";");
  assert.match(graph, /trim=start=0\.000:end=10\.000/);
  assert.match(graph, /trim=start=10\.000:end=13\.000,setpts=\(PTS-STARTPTS\)\/0\.5/);
  assert.match(graph, /atempo=0\.5000/);
  assert.match(graph, /concat=n=3:v=1:a=1/);
  assert.equal(vOut, "vspeed");
  assert.equal(aOut, "aspeed");
});

void test("freeze frame segment uses tpad clone and silent audio", () => {
  const map = buildTimeMap(
    [{ id: "a", type: "freeze_frame", start: 5, holdSeconds: 1.5 }],
    20,
  );
  const graph = buildSpeedChain(map, true).chains.join(";");
  assert.match(graph, /tpad=stop_mode=clone:stop_duration=1\.500/);
  assert.match(graph, /anullsrc=r=48000:cl=stereo,atrim=duration=1\.500/);
});

void test("gated effects use enable=between with timeline-capable filters", () => {
  const { chains, out } = buildGatedEffects(
    [
      { type: "color_grade", start: 2, end: 6, preset: "black_white" },
      { type: "flash", start: 8 },
      { type: "punch_in", start: 10, end: 12, factor: 1.4 },
    ],
    "vbase",
    1080,
    1920,
  );
  const graph = chains.join(";");
  assert.match(graph, /hue=s=0:enable='between\(t,2\.000,6\.000\)'/);
  assert.match(graph, /eq=brightness=0\.55:enable='between\(t,8\.000,8\.160\)'/);
  assert.match(graph, /crop=w=iw\/1\.4:h=ih\/1\.4,scale=1080:1920/);
  assert.match(graph, /overlay=0:0:enable='between\(t,10\.000,12\.000\)'/);
  assert.ok(out.startsWith("fx"));
});

void test("path expression interpolates between keyframes", () => {
  const expr = buildPathExpression(
    [
      { t: 1, x: 0.2, y: 0.5 },
      { t: 3, x: 0.8, y: 0.5 },
    ],
    "x",
    1000,
  );
  // Before first kf → 200; between → lerp; after → 800
  assert.match(expr, /if\(lt\(t,1\.000\),200\.0/);
  assert.match(expr, /200\.0\+\(800\.0-200\.0\)\*\(t-1\.000\)\/2\.000/);
});

void test("glow trail overlays several delayed fading copies", () => {
  const { chains, out } = buildGlowTrail(
    {
      id: "t1",
      type: "glow_trail",
      keyframes: [
        { t: 1, x: 0.1, y: 0.2 },
        { t: 2, x: 0.9, y: 0.8 },
      ],
    },
    "vzoom",
    1,
    1080,
    1920,
    30,
  );
  const graph = chains.join(";");
  assert.match(graph, /\[1:v\]format=rgba,split=6/);
  assert.match(graph, /tpad=stop_mode=clone:stop_duration=31\.00/);
  // Delayed copy shifts t in the path expression
  assert.match(graph, /\(t-0\.350\)/);
  assert.match(graph, /colorchannelmixer=aa=/);
  assert.equal(out, "tr0");
});
