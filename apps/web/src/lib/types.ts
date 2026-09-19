import type {
  HighlightSummary,
  ProjectSummary,
  VideoSourceSummary,
} from "@clipforge/shared-types";

export interface ProjectListResponse {
  items: ProjectSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ProjectDetail extends ProjectSummary {
  error: string | null;
  transcript: { status: string; language: string | null } | null;
  highlights: HighlightSummary[];
  clips: Array<{
    id: string;
    name: string | null;
    status: string;
    format: string | null;
    duration: number | null;
    updatedAt: string;
  }>;
  mediaUrl: string | null;
}

export interface ClipDetailResponse {
  id: string;
  projectId: string;
  name: string | null;
  status: string;
  format: string | null;
  resolution: string | null;
  duration: number | null;
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

export interface GenerateHighlightsInput {
  clipDuration: number;
  clipCount: number;
  format: string;
  editingStyle: string;
  captionStyle: string;
}

export type { ProjectSummary, VideoSourceSummary };
