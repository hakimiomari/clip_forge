/**
 * "Title of the video.mp4" — what a download saves as. Presigning then
 * reduces it further to what is safe in a Content-Disposition header.
 */
export function downloadFileName(
  title: string | null,
  fallback: string,
  extension = "mp4",
): string {
  const base = (title ?? "")
    .replace(/\.[a-z0-9]{2,4}$/i, "")
    .replace(/[^A-Za-z0-9 ._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
  return `${base || fallback}.${extension}`;
}
