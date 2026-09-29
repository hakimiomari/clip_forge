/**
 * Downloads: a YouTube link becomes a file on the user's computer,
 * without a project. The worker fetches the video, keeps it in storage
 * for the browser to save, and the Downloads page lists them.
 */

export type DownloadQuality = "1080p" | "720p" | "480p" | "audio";

export const DOWNLOAD_QUALITIES: Array<{
  value: DownloadQuality;
  label: string;
  hint: string;
}> = [
  { value: "1080p", label: "1080p", hint: "Full HD MP4 — the best YouTube has, up to 1080p" },
  { value: "720p", label: "720p", hint: "HD MP4 — about half the size of 1080p" },
  { value: "480p", label: "480p", hint: "Smaller MP4 for phones and slow connections" },
  { value: "audio", label: "Audio only", hint: "M4A sound track — no picture" },
];

export type DownloadStatus = "PENDING" | "DOWNLOADING" | "SAVING" | "READY" | "FAILED";

/** Downloads a user can have waiting or running at once. */
export const MAX_ACTIVE_DOWNLOADS = 5;

export interface DownloadSummary {
  id: string;
  url: string;
  videoId: string;
  title: string | null;
  channel: string | null;
  /** YouTube's own thumbnail — available before the download starts */
  thumbnailUrl: string;
  duration: number | null;
  quality: DownloadQuality;
  status: DownloadStatus;
  /** 0–100 while DOWNLOADING */
  progress: number;
  error: string | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  createdAt: string;
  fileName: string;
  /** Presigned, saves as `fileName` — present only when READY */
  fileUrl: string | null;
}

/** File extension a quality produces. */
export function downloadExtension(quality: DownloadQuality): "mp4" | "m4a" {
  return quality === "audio" ? "m4a" : "mp4";
}
