/**
 * Timeline JSON structure persisted per clip (Timeline.data).
 * The editor reads/writes this; the render pipeline consumes it.
 * `version` lets us migrate persisted timelines as the format evolves.
 */

export const TIMELINE_VERSION = 1;

export type TrackType = "video" | "caption" | "text" | "audio" | "effect";

export interface TimelineData {
  version: number;
  duration: number; // seconds
  format: import("./queues.js").VideoFormat;
  resolution: { width: number; height: number };
  tracks: TimelineTrack[];
  background?: BackgroundConfig;
}

export interface TimelineTrack {
  type: TrackType;
  items: TimelineItem[];
}

export type TimelineItem =
  | VideoItem
  | CaptionItem
  | TextItem
  | AudioItem
  | EffectItem;

interface BaseItem {
  id: string;
  timelineStart: number; // seconds on the clip timeline
  timelineEnd: number;
}

export interface VideoItem extends BaseItem {
  kind: "video";
  sourceStart: number; // seconds in the source media
  sourceEnd: number;
  crop?: CropConfig;
  speed?: number; // 1 = normal
  volume?: number; // 0–1
  transitionOut?: TransitionConfig;
}

export interface CaptionItem extends BaseItem {
  kind: "caption";
  text: string;
  speaker?: string;
  highlightWords?: string[];
}

export interface TextItem extends BaseItem {
  kind: "text";
  text: string;
  position: { x: number; y: number }; // 0–1 normalized
  fontFamily?: string;
  fontSize?: number;
  color?: string;
  outline?: boolean;
  shadow?: boolean;
  opacity?: number;
  animation?: string;
}

export interface AudioItem extends BaseItem {
  kind: "audio";
  storageKey?: string; // background music etc.
  volume: number;
  fadeIn?: number;
  fadeOut?: number;
  ducking?: boolean;
}

export interface EffectItem extends BaseItem {
  kind: "effect";
  effect: EffectType;
  intensity?: number;
  params?: Record<string, number | string | boolean>;
}

export type EffectType =
  | "zoom_in"
  | "zoom_out"
  | "pan"
  | "blur"
  | "brightness"
  | "contrast"
  | "saturation"
  | "sharpen"
  | "vignette"
  | "freeze_frame";

export interface CropConfig {
  mode: "center" | "face_tracking" | "manual";
  // manual crop rect, normalized to source dimensions
  rect?: { x: number; y: number; width: number; height: number };
}

export interface TransitionConfig {
  type:
    | "fade"
    | "crossfade"
    | "slide"
    | "zoom"
    | "blur"
    | "flash"
    | "swipe"
    | "glitch"
    | "dissolve";
  duration: number; // seconds
}

export interface BackgroundConfig {
  type:
    | "blurred_original"
    | "solid"
    | "gradient"
    | "image"
    | "video"
    | "mirrored";
  color?: string;
  gradient?: { from: string; to: string; angle?: number };
  storageKey?: string;
  blurIntensity?: number; // 0–100
  padding?: number; // 0–1 of frame height reserved as padding
  videoScale?: number; // 0–1 scale of foreground video
  opacity?: number;
}

export function emptyTimeline(
  format: import("./queues.js").VideoFormat,
  duration: number,
): TimelineData {
  const resolution =
    format === "vertical"
      ? { width: 1080, height: 1920 }
      : format === "square"
        ? { width: 1080, height: 1080 }
        : { width: 1920, height: 1080 };
  return {
    version: TIMELINE_VERSION,
    duration,
    format,
    resolution,
    tracks: [
      { type: "video", items: [] },
      { type: "caption", items: [] },
      { type: "text", items: [] },
      { type: "audio", items: [] },
      { type: "effect", items: [] },
    ],
  };
}
