/**
 * Queue names and job payload contracts shared by the API (producers)
 * and the worker (consumers). Keep payloads small — pass IDs, let the
 * worker load state from the database.
 */

export const QUEUES = {
  VIDEO_IMPORT: "video-import",
  TRANSCRIPTION: "transcription",
  SCENE_ANALYSIS: "scene-analysis",
  HIGHLIGHT_GENERATION: "highlight-generation",
  CLIP_GENERATION: "clip-generation",
  CAPTION_GENERATION: "caption-generation",
  RENDER_VIDEO: "render-video",
  QUALITY_CHECK: "quality-check",
  CLEANUP_FILES: "cleanup-files",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface VideoImportJob {
  projectId: string;
  userId: string;
}

export interface TranscriptionJob {
  projectId: string;
  userId: string;
}

export interface SceneAnalysisJob {
  projectId: string;
  userId: string;
}

export interface HighlightGenerationJob {
  projectId: string;
  userId: string;
  options: HighlightGenerationOptions;
}

export interface HighlightGenerationOptions {
  clipDuration: number; // target seconds (30–120, or custom)
  clipCount: number; // 1 | 3 | 5 | 10
  format: VideoFormat;
  editingStyle: EditingStyle;
  captionStyle: CaptionStyleName;
}

export interface ClipGenerationJob {
  clipId: string;
  userId: string;
}

export interface CaptionGenerationJob {
  clipId: string;
  userId: string;
}

export interface RenderVideoJob {
  clipId: string;
  renderJobId: string;
  userId: string;
}

export interface QualityCheckJob {
  clipId: string;
  renderJobId: string;
  userId: string;
}

export interface CleanupFilesJob {
  storageKeys: string[];
}

export type VideoFormat = "vertical" | "square" | "landscape";

export type EditingStyle =
  | "clean_professional"
  | "dynamic_viral"
  | "educational"
  | "podcast"
  | "news"
  | "cinematic"
  | "minimal";

export type CaptionStyleName =
  | "minimal"
  | "bold_dynamic"
  | "karaoke"
  | "highlighted_keywords"
  | "podcast"
  | "professional"
  | "news";

/** Realtime progress event emitted over WebSocket per project. */
export interface ProjectProgressEvent {
  projectId: string;
  status: string;
  progress: number; // 0–100
  step: string;
  error?: string;
}
