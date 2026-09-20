import type { PlanCta } from "@clipforge/shared-types";
import { assTime, escapeAssText } from "./captions";

/**
 * "Like & Follow" call-to-action banner, rendered as its own ASS track
 * burned in after captions. Uses glyphs with broad font coverage
 * (♥ U+2665, ► U+25BA) rather than color emoji, which FFmpeg cannot
 * rasterize reliably.
 */

export interface CtaRenderOptions {
  width: number;
  height: number;
  /** Final clip duration in OUTPUT time (after speed effects) */
  outputDuration: number;
}

/** Visible window for the banner given the timing mode. */
export function ctaWindow(
  timing: PlanCta["timing"],
  duration: number,
  custom?: { start?: number; end?: number },
): { start: number; end: number } {
  if (timing === "custom") {
    const start = Math.max(0, Math.min(custom?.start ?? 0, duration - 0.5));
    const end = Math.max(start + 0.5, Math.min(custom?.end ?? duration, duration));
    return { start, end };
  }
  switch (timing) {
    case "start":
      return { start: 0.8, end: Math.min(duration - 0.5, 5.8) };
    case "end":
      return { start: Math.max(0.5, duration - 6), end: duration - 0.8 };
    case "always":
      return { start: 0.3, end: duration - 0.3 };
    case "middle":
    default: {
      const start = Math.max(1, duration * 0.4);
      return { start, end: Math.min(duration - 0.8, start + 4.5) };
    }
  }
}

export function buildCtaAss(cta: PlanCta, opts: CtaRenderOptions): string {
  const fontSize = Math.round(opts.height * 0.026);
  const marginV = Math.round(
    opts.height * (cta.position === "top" ? 0.055 : 0.16),
  );
  const alignment = cta.position === "top" ? 8 : 2;
  const { start, end } = ctaWindow(cta.timing, opts.outputDuration, {
    start: cta.customStart,
    end: cta.customEnd,
  });

  const like = escapeAssText(cta.likeText.trim().toUpperCase() || "LIKE");
  const follow = escapeAssText(cta.followText.trim().toUpperCase() || "FOLLOW");

  // Red heart + white text on a brand-purple pill (BorderStyle=3 box);
  // pop-in scale + fade unless shown for a long stretch.
  const longWindow = end - start > 15;
  const anim =
    cta.timing === "always" || longWindow
      ? "{\\fad(400,400)}"
      : "{\\fad(250,250)\\t(0,320,\\fscx112\\fscy112)\\t(320,640,\\fscx100\\fscy100)}";
  const text =
    `${anim}{\\c&H3B3BFF&}♥{\\c&HFFFFFF&} ${like}   ` +
    `{\\c&H38E1C6&}►{\\c&HFFFFFF&} ${follow}`;

  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${opts.width}
PlayResY: ${opts.height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cta,Arial,${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&HB2FF5C6D,-1,0,0,0,100,100,1,0,3,7,0,${alignment},60,60,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 1,${assTime(start)},${assTime(end)},Cta,,0,0,0,,${text}
`;
}
