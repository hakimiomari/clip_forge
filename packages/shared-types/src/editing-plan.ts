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
