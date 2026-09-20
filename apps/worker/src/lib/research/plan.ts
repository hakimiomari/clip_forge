import {
  estimateSpokenSeconds,
  splitIntoScenes,
  type ResearchMedia,
  type ResearchPlan,
  type ResearchScene,
} from "@clipforge/shared-types";
import type { Article } from "./sources";

/**
 * Turns an article and the media found for it into an ordered scene
 * list. Deliberately deterministic: each scene's words are a sentence
 * that appears in the article, so the video can't state something the
 * source doesn't.
 */
export function buildResearchPlan(options: {
  article: Article;
  images: ResearchMedia[];
  videos: ResearchMedia[];
  maxScenes: number;
}): ResearchPlan {
  const { article, images, videos, maxScenes } = options;

  // The summary leads — it is the encyclopaedic "what is this" — then
  // the body carries on where it left off.
  const lead = splitIntoScenes(article.summary, 3);
  const rest = splitIntoScenes(article.body, maxScenes * 2).filter(
    (s) => !lead.includes(s),
  );
  const sentences = [...lead, ...rest].slice(0, maxScenes);

  // Video clips are scarcer than stills, so spend them early where they
  // hold attention most, then fall back to pictures.
  const reel: ResearchMedia[] = [...videos, ...images];

  const scenes: ResearchScene[] = sentences.map((text, i) => ({
    text,
    seconds: Math.round(estimateSpokenSeconds(text) * 10) / 10,
    // Cycle the media if there are fewer files than sentences rather
    // than leaving later scenes blank
    media: reel.length > 0 ? reel[i % reel.length]! : null,
  }));

  return {
    title: article.title,
    articleUrl: article.url,
    summary: article.summary,
    scenes,
  };
}

/** Credits listing every source used, for the description. */
export function buildAttribution(plan: ResearchPlan): string {
  const lines = [`Source: ${plan.title} — ${plan.articleUrl} (CC BY-SA)`];
  const seen = new Set<string>();
  for (const scene of plan.scenes) {
    const media = scene.media;
    if (!media || seen.has(media.sourceUrl)) continue;
    seen.add(media.sourceUrl);
    lines.push(
      `${media.title} — ${media.author} (${media.license})${
        media.pageUrl ? ` ${media.pageUrl}` : ""
      }`,
    );
  }
  return lines.join("\n");
}
