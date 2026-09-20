/**
 * Research videos: a video built from a topic instead of footage.
 *
 * Facts come from Wikipedia and the pictures and clips from Wikimedia
 * Commons, so everything used is openly licensed and every scene keeps
 * the attribution it needs. Nothing is invented: each scene's narration
 * is a sentence that exists in the source article.
 */

export type ResearchFormat = "vertical" | "square" | "landscape";

export interface ResearchMedia {
  kind: "image" | "video";
  /** Where the file came from, for the credits and for re-fetching */
  sourceUrl: string;
  /** Commons file page, so a viewer can check the licence themselves */
  pageUrl?: string;
  title: string;
  license: string;
  author: string;
}

export interface ResearchScene {
  /** Sentence spoken and captioned over this scene, from the article */
  text: string;
  seconds: number;
  media: ResearchMedia | null;
}

export interface ResearchPlan {
  title: string;
  /** Article the facts came from */
  articleUrl: string;
  summary: string;
  scenes: ResearchScene[];
}

export interface ResearchVideoSummary {
  id: string;
  prompt: string;
  title: string | null;
  description: string | null;
  status: "PENDING" | "RESEARCHING" | "BUILDING" | "RENDERING" | "READY" | "FAILED";
  error: string | null;
  format: string;
  progress: number;
  step: string | null;
  duration: number | null;
  createdAt: string;
  /** Presigned, only when the video is READY */
  videoUrl?: string | null;
  scenes?: ResearchScene[] | null;
}

/** What a research video costs, before it is built. */
export const RESEARCH_VIDEO_CREDITS = 4;

/** Scene length bounds — long enough to read, short enough to hold. */
export const MIN_SCENE_SECONDS = 3;
export const MAX_SCENE_SECONDS = 9;

/**
 * Roughly how long a sentence takes to say, used to size each scene
 * when there is no narration audio to measure. ~2.6 words/second is a
 * comfortable documentary pace.
 */
export function estimateSpokenSeconds(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const seconds = words / 2.6 + 0.8;
  return Math.max(MIN_SCENE_SECONDS, Math.min(MAX_SCENE_SECONDS, seconds));
}

/** Longest sentence worth narrating — beyond this a scene drags. */
const MAX_SENTENCE_CHARS = 220;

/**
 * Wiki plumbing that leaks into plain-text article extracts: template
 * and maintenance links, namespace prefixes, bare URLs. Narrating one
 * of these reads as gibberish, so they are dropped rather than cleaned.
 */
function isProse(sentence: string): boolean {
  if (/%[0-9A-Fa-f]{2}/.test(sentence)) return false; // URL-encoded markup
  if (/\b(?:Wikipedia|Template|Category|File|Portal|Help|Module):/i.test(sentence)) {
    return false;
  }
  if (/https?:\/\/|www\./i.test(sentence)) return false;
  if (/[{}|=<>]/.test(sentence)) return false; // template syntax
  // Real prose is mostly letters and spaces; markup is mostly not
  const letters = (sentence.match(/[A-Za-z\s]/g) ?? []).length;
  return letters / sentence.length >= 0.75;
}

/**
 * Splits article prose into scene-sized sentences, dropping the
 * fragments and wiki debris that make narration sound broken.
 */
export function splitIntoScenes(text: string, maxScenes: number): string[] {
  const cleaned = text
    .replace(/\[[^\]]*\]/g, "") // citation markers
    .replace(/\([^)]{0,80}\)/g, " ") // parenthetical asides read badly aloud
    .replace(/\s+/g, " ")
    // Removing an aside leaves a gap before its punctuation ("Council .")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
  const sentences = cleaned
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“])/)
    .map((s) => s.trim())
    .filter(
      (s) =>
        s.length >= 40 &&
        s.length <= MAX_SENTENCE_CHARS &&
        /[a-z]/.test(s) &&
        isProse(s),
    );
  return sentences.slice(0, maxScenes);
}
