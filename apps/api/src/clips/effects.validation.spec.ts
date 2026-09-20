import { BadRequestException } from "@nestjs/common";
import { validateRangeEffects } from "./effects.validation";

describe("validateRangeEffects", () => {
  const DUR = 30;

  it("accepts a full valid effect set", () => {
    const effects = validateRangeEffects(
      [
        { type: "slow_motion", start: 10, end: 13, factor: 0.5 },
        { type: "freeze_frame", start: 20, holdSeconds: 1.5 },
        { type: "color_grade", start: 0, end: 8, preset: "cinematic" },
        { type: "punch_in", start: 14, end: 16, factor: 1.4 },
        { type: "flash", start: 10 },
        {
          type: "glow_trail",
          keyframes: [
            { t: 1, x: 0.2, y: 0.3 },
            { t: 2.5, x: 0.8, y: 0.6 },
          ],
          color: "ffd25a",
          size: 1.2,
        },
      ],
      DUR,
    );
    expect(effects).toHaveLength(6);
    expect(effects.every((e) => typeof e.id === "string")).toBe(true);
  });

  it("rejects out-of-range times", () => {
    expect(() =>
      validateRangeEffects([{ type: "flash", start: 45 }], DUR),
    ).toThrow(BadRequestException);
  });

  it("rejects invalid slow-motion factors", () => {
    expect(() =>
      validateRangeEffects(
        [{ type: "slow_motion", start: 1, end: 5, factor: 1.5 }],
        DUR,
      ),
    ).toThrow(BadRequestException);
  });

  it("rejects overlapping speed effects", () => {
    expect(() =>
      validateRangeEffects(
        [
          { type: "slow_motion", start: 5, end: 10, factor: 0.5 },
          { type: "speed_up", start: 8, end: 14, factor: 2 },
        ],
        DUR,
      ),
    ).toThrow(/must not overlap/);
  });

  it("accepts a valid speed ramp with defaults", () => {
    const [ramp] = validateRangeEffects(
      [
        {
          type: "speed_ramp",
          keyframes: [
            { t: 5, speed: 1 },
            { t: 8, speed: 0.1 },
            { t: 12, speed: 2 },
          ],
        },
      ],
      DUR,
    );
    expect(ramp).toMatchObject({
      type: "speed_ramp",
      smoothness: 1,
      interpolation: "dup",
      muteBelowSpeed: 0.25,
    });
  });

  it("rejects a speed ramp combined with basic speed effects", () => {
    expect(() =>
      validateRangeEffects(
        [
          {
            type: "speed_ramp",
            keyframes: [
              { t: 2, speed: 1 },
              { t: 6, speed: 0.2 },
            ],
          },
          { type: "slow_motion", start: 10, end: 14, factor: 0.5 },
        ],
        DUR,
      ),
    ).toThrow(/replaces slow motion/);
  });

  it("rejects out-of-range ramp speeds", () => {
    expect(() =>
      validateRangeEffects(
        [
          {
            type: "speed_ramp",
            keyframes: [
              { t: 2, speed: 0.01 },
              { t: 6, speed: 1 },
            ],
          },
        ],
        DUR,
      ),
    ).toThrow(/0\.05–4/);
  });

  it("rejects trails with fewer than 2 keyframes", () => {
    expect(() =>
      validateRangeEffects(
        [{ type: "glow_trail", keyframes: [{ t: 1, x: 0.5, y: 0.5 }] }],
        DUR,
      ),
    ).toThrow(BadRequestException);
  });

  it("rejects unknown types and non-arrays", () => {
    expect(() => validateRangeEffects([{ type: "explode" }], DUR)).toThrow(
      BadRequestException,
    );
    expect(() => validateRangeEffects("nope", DUR)).toThrow(BadRequestException);
  });
});
