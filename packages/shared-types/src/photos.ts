/**
 * Video to photos: a YouTube link becomes a set of full-quality stills
 * spread across the whole video, without a project.
 */

export type PhotoPickMode = "scenes" | "even";

export const PHOTO_MODES: Array<{ value: PhotoPickMode; label: string; hint: string }> = [
  {
    value: "scenes",
    label: "Best moments",
    hint: "One photo per distinct shot, spread across the whole video",
  },
  {
    value: "even",
    label: "Evenly spaced",
    hint: "One photo at a fixed interval from start to end",
  },
];

export const PHOTO_COUNTS = [12, 24, 48] as const;
export const MAX_PHOTOS = 48;

/** Photo sets a user can have waiting or running at once. */
export const MAX_ACTIVE_PHOTO_SETS = 3;

export type PhotoSetStatus =
  | "PENDING"
  | "FINDING"
  | "CAPTURING"
  | "SAVING"
  | "READY"
  | "FAILED";

export interface VideoPhoto {
  index: number;
  /** Seconds into the video */
  time: number;
  width: number | null;
  height: number | null;
  sizeBytes: number;
  /** Presigned, shows in the browser */
  viewUrl: string;
  /** Presigned, saves as `fileName` */
  downloadUrl: string;
  fileName: string;
}

export interface PhotoSetSummary {
  id: string;
  url: string;
  videoId: string;
  title: string | null;
  channel: string | null;
  thumbnailUrl: string;
  duration: number | null;
  mode: PhotoPickMode;
  count: number;
  status: PhotoSetStatus;
  progress: number;
  step: string | null;
  error: string | null;
  createdAt: string;
  /** Present only when READY */
  photos: VideoPhoto[] | null;
  zipUrl: string | null;
  zipFileName: string;
  zipBytes: number | null;
}

/** Stored per photo on the row; URLs are signed when it is read. */
export interface StoredPhoto {
  index: number;
  time: number;
  key: string;
  width: number | null;
  height: number | null;
  sizeBytes: number;
}

/** Opening and closing stretch skipped: title cards, logos, end screens. */
export function photoWindow(duration: number): { start: number; end: number } {
  const margin = Math.min(15, duration * 0.03);
  return { start: margin, end: Math.max(margin, duration - margin) };
}

/** `count` times spread evenly across the video, in the middle of each slice. */
export function evenPhotoTimes(duration: number, count: number): number[] {
  if (duration <= 0 || count <= 0) return [];
  const { start, end } = photoWindow(duration);
  const span = end - start;
  const n = Math.max(1, Math.min(count, Math.floor(span) || 1));
  return Array.from({ length: n }, (_, i) => round1(start + span * ((i + 0.5) / n)));
}

/**
 * Photos from scene cuts, spread across the video: the video is split
 * into `count` equal slices and each slice gets its strongest cut. A
 * photo is taken a moment after the cut, so it shows the new shot rather
 * than the blend between two. A slice with no cut (one long shot) gets
 * its middle — every part of the video is still represented.
 */
export function pickSceneTimes(
  cuts: Array<{ time: number; score: number }>,
  duration: number,
  count: number,
  settleSeconds = 1,
): number[] {
  if (duration <= 0 || count <= 0) return [];
  const { start, end } = photoWindow(duration);
  const span = end - start;
  const n = Math.max(1, Math.min(count, Math.floor(span) || 1));
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const from = start + (span * i) / n;
    const to = start + (span * (i + 1)) / n;
    let best: { time: number; score: number } | null = null;
    for (const cut of cuts) {
      const at = cut.time + settleSeconds;
      if (at < from || at >= to) continue;
      if (!best || cut.score > best.score) best = cut;
    }
    times.push(round1(best ? best.time + settleSeconds : (from + to) / 2));
  }
  return times;
}

/** "12m34s" / "1h02m05s" — for file names. */
export function photoStamp(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (v: number) => String(v).padStart(2, "0");
  return h > 0 ? `${h}h${pad(m)}m${pad(s)}s` : `${pad(m)}m${pad(s)}s`;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
