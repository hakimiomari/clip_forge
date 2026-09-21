import type { ResearchMedia } from "@clipforge/shared-types";

/**
 * Open-licence research sources: Wikipedia for the facts, Wikimedia
 * Commons for the pictures and clips. Both are free and need no API
 * key, and Commons hands back the licence and author for every file so
 * each scene can carry its attribution.
 *
 * Wikimedia asks for a descriptive User-Agent; requests without one get
 * throttled or refused.
 */

const USER_AGENT =
  "ClipForge/0.1 (research video builder; https://github.com/clipforge)";
const TIMEOUT_MS = 20_000;

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`${new URL(url).host} returned HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

/** Strips the HTML Commons puts in its attribution fields. */
export function stripHtml(value: string | undefined): string {
  if (!value) return "";
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface Article {
  title: string;
  url: string;
  summary: string;
  body: string;
}

/** Finds the article that best matches the prompt. */
export async function findArticle(prompt: string): Promise<Article | null> {
  const search = await getJson<{
    query?: { search?: Array<{ title: string }> };
  }>(
    `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
      prompt,
    )}&srlimit=1&format=json&origin=*`,
  );
  const title = search.query?.search?.[0]?.title;
  if (!title) return null;

  const summary = await getJson<{
    title: string;
    extract?: string;
    content_urls?: { desktop?: { page?: string } };
  }>(
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
  );

  // The plain-text extract of the whole article gives enough sentences
  // for a full video; the summary alone is usually only a paragraph.
  const extract = await getJson<{
    query?: { pages?: Record<string, { extract?: string }> };
  }>(
    `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&exsectionformat=plain&titles=${encodeURIComponent(
      title,
    )}&format=json&origin=*`,
  );
  const body =
    Object.values(extract.query?.pages ?? {})[0]?.extract ?? summary.extract ?? "";

  return {
    title: summary.title ?? title,
    url:
      summary.content_urls?.desktop?.page ??
      `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`,
    summary: summary.extract ?? "",
    body,
  };
}

interface CommonsPage {
  title: string;
  imageinfo?: Array<{
    url?: string;
    thumburl?: string;
    descriptionurl?: string;
    width?: number;
    height?: number;
    mediatype?: string;
    extmetadata?: Record<string, { value?: string }>;
  }>;
}

function toMedia(page: CommonsPage, kind: "image" | "video"): ResearchMedia | null {
  const info = page.imageinfo?.[0];
  const url = kind === "image" ? (info?.thumburl ?? info?.url) : info?.url;
  if (!info || !url) return null;
  const meta = info.extmetadata ?? {};
  return {
    kind,
    sourceUrl: url,
    pageUrl: info.descriptionurl,
    title: page.title.replace(/^File:/, ""),
    license: stripHtml(meta.LicenseShortName?.value) || "see file page",
    author: stripHtml(meta.Artist?.value) || "Wikimedia Commons",
  };
}

/**
 * Pictures for the topic, widest first — a small image stretched to
 * 1080 looks worse than no image at all.
 */
export async function findImages(query: string, limit: number): Promise<ResearchMedia[]> {
  const data = await getJson<{ query?: { pages?: Record<string, CommonsPage> } }>(
    `https://commons.wikimedia.org/w/api.php?action=query&generator=search` +
      `&gsrsearch=${encodeURIComponent(query)}&gsrnamespace=6&gsrlimit=${limit * 3}` +
      `&prop=imageinfo&iiprop=url%7Cextmetadata%7Csize%7Cmediatype&iiurlwidth=1600&format=json&origin=*`,
  );
  return Object.values(data.query?.pages ?? {})
    .filter((p) => {
      const info = p.imageinfo?.[0];
      // Drawings and icons scale badly and read as clip-art in a video
      return (
        info?.mediatype === "BITMAP" &&
        (info.width ?? 0) >= 800 &&
        !/\.svg$/i.test(p.title)
      );
    })
    .sort((a, b) => (b.imageinfo?.[0]?.width ?? 0) - (a.imageinfo?.[0]?.width ?? 0))
    .map((p) => toMedia(p, "image"))
    .filter((m): m is ResearchMedia => m !== null)
    .slice(0, limit);
}

/** Openly-licensed clips for the topic, if Commons has any. */
export async function findVideos(query: string, limit: number): Promise<ResearchMedia[]> {
  const data = await getJson<{ query?: { pages?: Record<string, CommonsPage> } }>(
    `https://commons.wikimedia.org/w/api.php?action=query&generator=search` +
      `&gsrsearch=${encodeURIComponent(`filetype:video ${query}`)}&gsrnamespace=6&gsrlimit=${limit * 2}` +
      `&prop=imageinfo&iiprop=url%7Cextmetadata%7Csize%7Cmediatype&format=json&origin=*`,
  );
  return Object.values(data.query?.pages ?? {})
    .filter((p) => p.imageinfo?.[0]?.mediatype === "VIDEO")
    .map((p) => toMedia(p, "video"))
    .filter((m): m is ResearchMedia => m !== null)
    .slice(0, limit);
}
