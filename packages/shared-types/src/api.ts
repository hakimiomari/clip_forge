/**
 * Shapes shared between the API responses and the web client.
 * (The API also validates inputs with class-validator DTOs server-side;
 * these are the read-model types the frontend consumes.)
 */

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  role: "USER" | "ADMIN";
  plan: "FREE" | "STARTER" | "PRO" | "BUSINESS";
  creditBalance: number;
}

export interface ProjectSummary {
  id: string;
  name: string;
  status: string;
  sourceUrl: string | null;
  createdAt: string;
  updatedAt: string;
  source: VideoSourceSummary | null;
  clipCount: number;
  highlightCount: number;
}

export interface VideoSourceSummary {
  id: string;
  sourceType: "UPLOAD" | "YOUTUBE" | "S3_URL";
  title: string | null;
  thumbnailUrl: string | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  rights: string;
}

export interface HighlightSummary {
  id: string;
  startTime: number;
  endTime: number;
  duration: number;
  score: number | null;
  title: string | null;
  hook: string | null;
  reason: string | null;
  category: string | null;
  confidence: number | null;
}

export interface ClipSummary {
  id: string;
  projectId: string;
  highlightId: string | null;
  name: string | null;
  status: string;
  format: string | null;
  resolution: string | null;
  duration: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExportSummary {
  id: string;
  clipId: string;
  fileName: string;
  format: string;
  resolution: string;
  sizeBytes: number | null;
  createdAt: string;
}

export interface PresignedUpload {
  uploadUrl: string;
  storageKey: string;
  expiresIn: number;
}

export interface DownloadLink {
  status: "completed";
  fileName: string;
  downloadUrl: string;
  expiresIn: number;
}

export interface DashboardStats {
  totalProjects: number;
  totalClips: number;
  completedExports: number;
  processingJobs: number;
  remainingCredits: number;
}

/** Options the web app sends when creating a clip from a highlight. */
export interface CreateClipInput {
  name?: string;
  format: "vertical" | "square" | "landscape";
  captionsEnabled: boolean;
  captionStyle: string;
  zoomEnabled: boolean;
  /** Fine-trim offsets (seconds) applied to the highlight window */
  trimStartDelta?: number;
  trimEndDelta?: number;
}

export interface ClipDetail extends ClipSummary {
  renderJob: {
    id: string;
    status: string;
    progress: number;
    step: string | null;
    error: string | null;
  } | null;
  hasExport: boolean;
  previewUrl: string | null;
}
