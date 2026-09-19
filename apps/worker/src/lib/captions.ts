/**
 * Caption Agent output: converts caption rows (clip-relative timing)
 * into a styled ASS subtitle file that FFmpeg burns into the video.
 */

export interface CaptionLine {
  startTime: number; // seconds, relative to clip start
  endTime: number;
  text: string;
}

export interface CaptionRenderOptions {
  style: string; // CaptionStyleName
  position: "top" | "center" | "bottom";
  width: number;
  height: number;
}

interface AssStyle {
  fontName: string;
  fontScale: number; // fraction of frame height
  bold: boolean;
  uppercase: boolean;
  primary: string; // &HAABBGGRR
  outlineColor: string;
  backColor: string;
  borderStyle: 1 | 3; // 1 outline+shadow, 3 boxed
  outline: number;
  shadow: number;
  maxWordsPerLine: number;
}

const STYLES: Record<string, AssStyle> = {
  bold_dynamic: {
    fontName: "Arial",
    fontScale: 0.042,
    bold: true,
    uppercase: true,
    primary: "&H00FFFFFF",
    outlineColor: "&H00000000",
    backColor: "&H80000000",
    borderStyle: 1,
    outline: 7,
    shadow: 2,
    maxWordsPerLine: 4,
  },
  minimal: {
    fontName: "Arial",
    fontScale: 0.03,
    bold: false,
    uppercase: false,
    primary: "&H00FFFFFF",
    outlineColor: "&H00000000",
    backColor: "&H60000000",
    borderStyle: 1,
    outline: 3,
    shadow: 0,
    maxWordsPerLine: 7,
  },
  professional: {
    fontName: "Arial",
    fontScale: 0.028,
    bold: false,
    uppercase: false,
    primary: "&H00FFFFFF",
    outlineColor: "&H00000000",
    backColor: "&H7A000000",
    borderStyle: 3,
    outline: 1,
    shadow: 0,
    maxWordsPerLine: 8,
  },
  news: {
    fontName: "Arial",
    fontScale: 0.03,
    bold: true,
    uppercase: false,
    primary: "&H00FFFFFF",
    outlineColor: "&H00000000",
    backColor: "&HA0201000",
    borderStyle: 3,
    outline: 1,
    shadow: 0,
    maxWordsPerLine: 8,
  },
  podcast: {
    fontName: "Arial",
    fontScale: 0.036,
    bold: true,
    uppercase: false,
    primary: "&H0000E7FF", // warm yellow (BGR)
    outlineColor: "&H00000000",
    backColor: "&H80000000",
    borderStyle: 1,
    outline: 5,
    shadow: 1,
    maxWordsPerLine: 5,
  },
};

function resolveStyle(name: string): AssStyle {
  const style =
    STYLES[name] ??
    // karaoke / highlighted_keywords render as bold until word-level
    // timings arrive (word timestamps are a transcription upgrade)
    STYLES["bold_dynamic"];
  return style as AssStyle;
}

export function buildAssDocument(
  captions: CaptionLine[],
  opts: CaptionRenderOptions,
): string {
  const style = resolveStyle(opts.style);
  const fontSize = Math.round(opts.height * style.fontScale);
  const alignment = opts.position === "top" ? 8 : 2; // top-center / bottom-center
  const marginV =
    opts.position === "center"
      ? Math.round(opts.height * 0.34) // lower-middle "reels" placement
      : opts.position === "top"
        ? Math.round(opts.height * 0.08)
        : Math.round(opts.height * 0.09);
  const marginX = Math.round(opts.width * 0.06);

  const events = captions
    .flatMap((c) => splitCaption(c, style.maxWordsPerLine))
    .filter((c) => c.endTime - c.startTime > 0.05 && c.text.trim().length > 0)
    .map((c) => {
      let text = escapeAssText(c.text.trim());
      if (style.uppercase) text = text.toUpperCase();
      return `Dialogue: 0,${assTime(c.startTime)},${assTime(c.endTime)},Caption,,0,0,0,,${text}`;
    })
    .join("\n");

  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${opts.width}
PlayResY: ${opts.height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,${style.fontName},${fontSize},${style.primary},${style.primary},${style.outlineColor},${style.backColor},${style.bold ? -1 : 0},0,0,0,100,100,0,0,${style.borderStyle},${style.outline},${style.shadow},${alignment},${marginX},${marginX},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events}
`;
}

/**
 * Splits a sentence-level caption into short punchy chunks, distributing
 * the time span proportionally to word count.
 */
export function splitCaption(
  caption: CaptionLine,
  maxWords: number,
): CaptionLine[] {
  const words = caption.text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  if (words.length <= maxWords) return [caption];

  const chunkCount = Math.ceil(words.length / maxWords);
  const perChunk = Math.ceil(words.length / chunkCount);
  const total = caption.endTime - caption.startTime;
  const chunks: CaptionLine[] = [];
  let cursor = caption.startTime;
  for (let i = 0; i < words.length; i += perChunk) {
    const chunkWords = words.slice(i, i + perChunk);
    const share = (chunkWords.length / words.length) * total;
    chunks.push({
      startTime: cursor,
      endTime: Math.min(caption.endTime, cursor + share),
      text: chunkWords.join(" "),
    });
    cursor += share;
  }
  return chunks;
}

export function assTime(seconds: number): string {
  const total = Math.max(0, seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const cs = Math.round((total - Math.floor(total)) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

export function escapeAssText(text: string): string {
  return text
    .replace(/\{/g, "(")
    .replace(/\}/g, ")")
    .replace(/\r?\n/g, "\\N");
}
