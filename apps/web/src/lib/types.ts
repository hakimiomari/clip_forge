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

export type { ProjectSummary, VideoSourceSummary };
