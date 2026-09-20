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
  editingPlan?: {
    segments?: Array<{ sourceStart: number; sourceEnd: number }>;
    rangeEffects?: Array<Record<string, unknown>>;
    background?: { type: string } | null;
    captions?: { enabled: boolean; style: string };
    audio?: {
      originalVolume?: number;
      pitchSemitones?: number;
      bassGain?: number;
      trebleGain?: number;
      noiseReduction?: boolean;
      voiceEnhance?: boolean;
      voiceEffect?: string;
      normalize?: boolean;
    };
  } | null;
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
  useTranscript?: boolean;
}

export interface TranscriptResponse {
  status: string;
  language: string | null;
  provider: string | null;
  error?: string | null;
  segments: Array<{
    startTime: number;
    endTime: number;
    text: string;
    speaker: string | null;
  }>;
}

export type { ProjectSummary, VideoSourceSummary };
