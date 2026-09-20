/**
 * Ready-to-paste title and description for a rendered short.
 *
 * Deliberately built from facts the project already holds — the words
 * actually spoken in the clip, the source video's own title, where the
 * moment sits in it, and the link back — rather than from a language
 * model. Nothing here can hallucinate a statistic or invent a quote,
 * and it works with no API key configured.
 */

/** YouTube caps titles at 100 characters; leave room for a suffix. */
const MAX_TITLE = 95;
const MAX_QUOTE = 400;
const MAX_HASHTAGS = 6;

/** Words too generic to be worth a hashtag. */
const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "his", "her", "its",
  "match", "full", "video", "highlights", "official", "part", "ep", "episode",
  "vs", "v", "watch", "live", "new", "day", "big", "best", "top", "how", "why",
]);

export interface ClipMetadataInput {
  /** Title of the video the clip came from */
  sourceTitle?: string | null;
  /** Link back to the original, when there is one */
  sourceUrl?: string | null;
  /** Where the clip sits in the source, in seconds */
  parts: Array<{ start: number; end: number }>;
  /** Lines actually spoken inside the clip, in order */
  spokenLines?: string[];
  /** Title the highlight step derived from the transcript */
  highlightTitle?: string | null;
  /** Name the user gave the clip, if any */
  clipName?: string | null;
}

function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, "0");
  return h > 0
    ? `${h}:${mm}:${String(s).padStart(2, "0")}`
    : `${mm}:${String(s).padStart(2, "0")}`;
}

function tidy(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Cuts at a word boundary rather than mid-word. */
function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * A title taken from the clip itself: the user's name for it, else what
 * the highlight step read out of the transcript, else the first thing
 * said, else the source video and timestamp.
 */
export function buildClipTitle(input: ClipMetadataInput): string {
  const candidates = [
    input.clipName,
    input.highlightTitle,
    input.spokenLines?.[0],
  ];
  for (const candidate of candidates) {
    const text = tidy(candidate ?? "");
    // Ignore the placeholder names clips get when nothing better exists
    if (text && text.toLowerCase() !== "clip") return truncate(text, MAX_TITLE);
  }
  const start = input.parts[0]?.start ?? 0;
  const source = tidy(input.sourceTitle ?? "");
  return truncate(source ? `${source} — ${formatTimestamp(start)}` : "Clip", MAX_TITLE);
}

/**
 * Hashtags from words that genuinely appear in the source title —
 * no invented topics.
 */
export function buildHashtags(sourceTitle?: string | null): string[] {
  if (!sourceTitle) return [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of sourceTitle.split(/[^A-Za-z0-9]+/)) {
    const word = raw.toLowerCase();
    if (word.length < 3 || STOP_WORDS.has(word) || /^\d+$/.test(word)) continue;
    if (seen.has(word)) continue;
    seen.add(word);
    tags.push(`#${word}`);
    if (tags.length >= MAX_HASHTAGS) break;
  }
  return tags;
}

/**
 * The description block. Every line is something the project knows to
 * be true; sections with no data are left out entirely rather than
 * padded with filler.
 */
export function buildClipDescription(input: ClipMetadataInput): string {
  const blocks: string[] = [];

  const spoken = (input.spokenLines ?? []).map(tidy).filter(Boolean);
  if (spoken.length > 0) {
    blocks.push(`"${truncate(spoken.join(" "), MAX_QUOTE)}"`);
  }

  const source = tidy(input.sourceTitle ?? "");
  const where: string[] = [];
  if (source) where.push(`From: ${source}`);
  if (input.parts.length > 0) {
    const ranges = input.parts
      .map((p) => `${formatTimestamp(p.start)}–${formatTimestamp(p.end)}`)
      .join(", ");
    where.push(
      input.parts.length > 1
        ? `Moments used: ${ranges}`
        : `Moment: ${ranges} of the full video`,
    );
  }
  if (input.sourceUrl) where.push(`Full video: ${input.sourceUrl}`);
  if (where.length > 0) blocks.push(where.join("\n"));

  const hashtags = buildHashtags(input.sourceTitle);
  if (hashtags.length > 0) blocks.push(hashtags.join(" "));

  return blocks.join("\n\n");
}
