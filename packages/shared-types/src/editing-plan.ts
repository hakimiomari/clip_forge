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
    type: "blurred_original" | "solid" | "gradient";
    blurIntensity?: number;
    color?: string;
  };
  /** Advanced range-targeted effects (slow motion, color grades, trails…) */
  rangeEffects?: RangeEffect[];
}

// ── Advanced range effects ───────────────────────────────
// Times are seconds relative to the clip start (the trimmed window).
// Speed effects change the output duration; captions and gated effects
// are re-timed through the resulting time map by the renderer.

export type RangeEffect =
  | SlowMotionEffect
  | SpeedUpEffect
  | FreezeFrameEffect
  | ColorGradeEffect
  | PunchInEffect
  | FlashEffect
  | GlowTrailEffect;

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

export interface PlanAudio {
  originalVolume: number;
  backgroundMusic: boolean;
  musicStorageKey?: string;
  musicVolume: number;
  fadeIn: boolean;
  fadeOut: boolean;
  normalize?: boolean;
}
