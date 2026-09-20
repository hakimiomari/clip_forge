/**
 * A source the worker can analyse and cut: either media we hold in
 * storage (uploads) or a YouTube video the worker streams on demand.
 */
export function hasProcessableMedia(source: {
  sourceType: string;
  storageKey: string | null;
  externalId: string | null;
}): boolean {
  return (
    Boolean(source.storageKey) ||
    (source.sourceType === "YOUTUBE" && Boolean(source.externalId))
  );
}
