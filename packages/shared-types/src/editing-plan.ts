import type {
  CaptionStyleName,
  VideoFormat,
} from "./queues.js";
import type { CropConfig, TransitionConfig } from "./timeline.js";

/**
 * Editing plan emitted by the Editing Plan Agent (Clip.editingPlan).
 * It is the machine-readable recipe the clip-generation step turns
 * into a concrete Timeline, and the render pipeline can consume
 * directly for "no manual edit" flows.
 */

export const EDITING_PLAN_VERSION = 1;

export interface EditingPlan {
  version: number;
  duration: number;
  format: VideoFormat;
  resolution: string; // "1080x1920"
  template: string;
  segments: PlanSegment[];
  captions: PlanCaptions;
  transitions: TransitionConfig[];
  audio: PlanAudio;
  background?: {
    /**
     * blurred_original: fit video, blurred fill bars ·
     * crop_fill: scale to cover and center-crop (no bars) ·
     * solid/gradient: colored bars
     */
    type: "blurred_original" | "crop_fill" | "solid" | "gradient";
    blurIntensity?: number;
    color?: string;
  };
  /** Advanced range-targeted effects (slow motion, color grades, trails…) */
  rangeEffects?: RangeEffect[];
  /** Like/Follow call-to-action banner burned into the render */
  cta?: PlanCta;
  /** AI subject cut-out (per-frame segmentation) */
  backgroundRemoval?: PlanBackgroundRemoval;
  /** AI cartoon / anime stylization of the footage */
  cartoon?: PlanCartoon;
}

export type CartoonStyleName = "hayao" | "shinkai";

/**
 * Runs the clip through AnimeGANv3 before anything else is drawn, so
 * captions, the banner and the watermark stay crisp on top of the
 * stylized footage.
 */
export interface PlanCartoon {
  enabled: boolean;
  style: CartoonStyleName;
  /** Frames per second to stylize at — 12 reads as hand-drawn */
  fps: number;
}

// ── Advanced range effects ───────────────────────────────
// Times are seconds relative to the clip start (the trimmed window).
// Speed effects change the output duration; captions and gated effects
// are re-timed through the resulting time map by the renderer.

export type RangeEffect =
  | SlowMotionEffect
  | SpeedUpEffect
  | FreezeFrameEffect
  | SpeedRampEffect
  | ColorGradeEffect
  | PunchInEffect
  | FlashEffect
  | GlowTrailEffect;

// ── Speed ramping (variable velocity) ────────────────────

export interface SpeedKeyframe {
  /** Seconds relative to clip start */
  t: number;
  /** Playback speed at this point, 0.05–4 */
  speed: number;
}

export type RampInterpolation = "dup" | "blend" | "optical_flow";

/**
 * Keyframed variable velocity across the whole clip. Speed between
 * keyframes ramps with smooth ease-in/out; before the first and after
 * the last keyframe the clip plays at that keyframe's speed. Mutually
 * exclusive with slow_motion / speed_up / freeze_frame.
 */
export interface SpeedRampEffect {
  id: string;
  type: "speed_ramp";
  /** 2–8 keyframes, times ascending. Repeated speeds form plateaus. */
  keyframes: SpeedKeyframe[];
  /**
   * Ramp easing between keyframes, 0–1: 0 = linear velocity change,
   * 1 = fully eased (smooth ease-in/ease-out).
   */
  smoothness: number;
  /** Frame synthesis for slowed sections (optical_flow is much slower) */
  interpolation: RampInterpolation;
  /** Mute original audio when speed drops below this (0 disables) */
  muteBelowSpeed: number;
}

/** Preset ramps from the product spec, anchored at an impact time. */
export function speedRampPreset(
  name: "hero_moment" | "bullet_time",
  anchorSeconds: number,
  clipDuration: number,
): SpeedKeyframe[] {
  const clamp = (t: number) => Math.max(0, Math.min(clipDuration, Math.round(t * 100) / 100));
  if (name === "bullet_time") {
    return [
      { t: clamp(anchorSeconds - 2.5), speed: 1 },
      { t: clamp(anchorSeconds - 0.8), speed: 4 },
      { t: clamp(anchorSeconds - 0.1), speed: 0.05 },
      { t: clamp(anchorSeconds + 1.2), speed: 0.05 },
      { t: clamp(anchorSeconds + 2.2), speed: 1 },
    ];
  }
  // hero_moment: normal → deep slow at impact → snap back
  return [
    { t: clamp(anchorSeconds - 1.5), speed: 1 },
    { t: clamp(anchorSeconds - 0.15), speed: 0.1 },
    { t: clamp(anchorSeconds + 0.9), speed: 0.1 },
    { t: clamp(anchorSeconds + 1.6), speed: 1 },
  ];
}

export interface SlowMotionEffect {
  id: string;
  type: "slow_motion";
  start: number;
  end: number;
  /** Playback speed, 0.25–0.9 (0.5 = half speed) */
  factor: number;
}

export interface SpeedUpEffect {
  id: string;
  type: "speed_up";
  start: number;
  end: number;
  /** Playback speed, 1.1–4 */
  factor: number;
}

export interface FreezeFrameEffect {
  id: string;
  type: "freeze_frame";
  /** Frame to hold (seconds) */
  start: number;
  /** Hold duration in seconds, 0.2–5 */
  holdSeconds: number;
}

export type ColorPreset =
  | "cinematic"
  | "warm"
  | "cool"
  | "black_white"
  | "vivid";

export interface ColorGradeEffect {
  id: string;
  type: "color_grade";
  start: number;
  end: number;
  preset: ColorPreset;
}

export interface PunchInEffect {
  id: string;
  type: "punch_in";
  start: number;
  end: number;
  /** Zoom factor, 1.1–2 */
  factor: number;
}

export interface FlashEffect {
  id: string;
  type: "flash";
  /** Moment of impact (seconds) */
  start: number;
}

export interface TrailKeyframe {
  /** Seconds relative to clip start */
  t: number;
  /** Normalized 0–1 position in the output frame */
  x: number;
  y: number;
}

export interface GlowTrailEffect {
  id: string;
  type: "glow_trail";
  /** 2–10 clicked positions of the tracked object */
  keyframes: TrailKeyframe[];
  /** Trail color as hex without # (default warm gold) */
  color?: string;
  /** 0.5–2 size multiplier */
  size?: number;
}

export interface PlanSegment {
  sourceStart: number;
  sourceEnd: number;
  crop: CropConfig;
  effects: PlanEffect[];
}

/** Most parts one clip may be stitched from. */
export const MAX_CLIP_PARTS = 12;

export const CLIP_RESOLUTIONS: Record<VideoFormat, string> = {
  vertical: "1080x1920",
  square: "1080x1080",
  landscape: "1920x1080",
};

/** One source range that becomes a part of a clip. */
export interface ClipPart {
  start: number;
  end: number;
}

export interface BuildEditingPlanOptions {
  /** Parts play back to back in this order */
  parts: ClipPart[];
  format: VideoFormat;
  captionsEnabled: boolean;
  captionStyle: CaptionStyleName | string;
  zoomEnabled: boolean;
  backgroundMode?: "blur" | "fill" | "black" | string;
  ctaEnabled?: boolean;
  cartoon?: PlanCartoon;
}

/**
 * The deterministic v1 "Editing Plan Agent": turns chosen ranges and
 * user options into the render recipe. Lives here because both the API
 * (manual and highlight clips) and the worker (automatic shorts) build
 * plans, and they must produce byte-identical output.
 */
export function buildEditingPlan(opts: BuildEditingPlanOptions): EditingPlan {
  const duration = opts.parts.reduce((sum, p) => sum + (p.end - p.start), 0);
  const background: EditingPlan["background"] =
    opts.backgroundMode === "fill"
      ? { type: "crop_fill" }
      : opts.backgroundMode === "black"
        ? undefined
        : { type: "blurred_original", blurIntensity: 55 };
  return {
    version: EDITING_PLAN_VERSION,
    duration,
    format: opts.format,
    resolution: CLIP_RESOLUTIONS[opts.format],
    template: "auto_v1",
    segments: opts.parts.map((part) => ({
      sourceStart: part.start,
      sourceEnd: part.end,
      crop: { mode: "center" as const },
      effects: opts.zoomEnabled
        ? [
            {
              type: "zoom_in" as const,
              start: 0,
              duration: part.end - part.start,
              intensity: 1.08,
            },
          ]
        : [],
    })),
    captions: {
      enabled: opts.captionsEnabled,
      style: opts.captionStyle as CaptionStyleName,
      position: "center",
      highlightKeywords: false,
      animation: "sentence",
    },
    transitions: [],
    audio: {
      originalVolume: 1,
      backgroundMusic: false,
      musicVolume: 0,
      fadeIn: true,
      fadeOut: true,
      normalize: true,
    },
    background,
    cta: {
      enabled: opts.ctaEnabled ?? true,
      likeText: "LIKE",
      followText: "FOLLOW",
      timing: "middle",
      position: "top",
    },
    ...(opts.cartoon?.enabled ? { cartoon: opts.cartoon } : {}),
  };
}

/**
 * Total length of the clip: segments play back to back, so this is the
 * sum of their source ranges (before any speed effects). Always use
 * this rather than `segments[0]` — clips can be stitched from parts.
 */
export function planTotalDuration(
  plan: Pick<EditingPlan, "segments"> | null | undefined,
): number {
  return (plan?.segments ?? []).reduce(
    (total, s) => total + Math.max(0, s.sourceEnd - s.sourceStart),
    0,
  );
}

export interface PlanEffect {
  type: "zoom_in" | "zoom_out" | "pan";
  start: number; // seconds relative to segment start
  duration: number;
  intensity: number; // e.g. 1.15 = 15% zoom
}

export interface PlanCaptions {
  enabled: boolean;
  style: CaptionStyleName;
  position: "top" | "center" | "bottom";
  highlightKeywords: boolean;
  animation: "none" | "word_by_word" | "karaoke" | "sentence";
}

export type VoiceEffect = "none" | "telephone" | "echo" | "robot";

export interface PlanBackgroundRemoval {
  enabled: boolean;
  /** What appears behind the cut-out subject */
  replace: "blur" | "color";
  /** Hex without # when replace = "color" */
  color?: string;
}

export type CtaTiming = "start" | "middle" | "end" | "always" | "custom";

export interface PlanCta {
  enabled: boolean;
  /** e.g. "LIKE" — rendered with a ♥ */
  likeText: string;
  /** e.g. "FOLLOW" or "SUBSCRIBE" — rendered with a ► */
  followText: string;
  timing: CtaTiming;
  /** Exact window (seconds, output time) when timing = "custom" */
  customStart?: number;
  customEnd?: number;
  position: "top" | "bottom";
}

export interface PlanAudio {
  /** Gain on the original audio: 0–3 (1 = normal, 2 = double) */
  originalVolume: number;
  backgroundMusic: boolean;
  musicStorageKey?: string;
  musicVolume: number;
  fadeIn: boolean;
  fadeOut: boolean;
  /** Loudness normalization (EBU R128) — default true */
  normalize?: boolean;
  /** Voice pitch in semitones, −12 (deep) … +12 (high); duration unchanged */
  pitchSemitones?: number;
  /** Bass shelf gain in dB, −10…10 */
  bassGain?: number;
  /** Treble shelf gain in dB, −10…10 */
  trebleGain?: number;
  /** FFT denoiser for hiss/hum */
  noiseReduction?: boolean;
  /** High-pass + presence EQ + compression for clearer speech */
  voiceEnhance?: boolean;
  voiceEffect?: VoiceEffect;
}
