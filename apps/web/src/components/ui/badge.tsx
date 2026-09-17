import { cn } from "@/lib/utils";

const statusStyles: Record<string, string> = {
  DRAFT: "bg-surface-raised text-muted border-border",
  IMPORTING: "bg-warning/10 text-warning border-warning/30",
  IMPORTED: "bg-accent/10 text-accent border-accent/30",
  ANALYZING: "bg-warning/10 text-warning border-warning/30",
  GENERATING_HIGHLIGHTS: "bg-warning/10 text-warning border-warning/30",
  READY: "bg-accent/10 text-accent border-accent/30",
  RENDERING: "bg-warning/10 text-warning border-warning/30",
  COMPLETED: "bg-success/10 text-success border-success/30",
  FAILED: "bg-danger/10 text-danger border-danger/30",
  ARCHIVED: "bg-surface-raised text-muted border-border",
};

const statusLabels: Record<string, string> = {
  DRAFT: "Draft",
  IMPORTING: "Importing…",
  IMPORTED: "Imported",
  ANALYZING: "Analyzing…",
  GENERATING_HIGHLIGHTS: "Finding highlights…",
  READY: "Ready",
  RENDERING: "Rendering…",
  COMPLETED: "Completed",
  FAILED: "Failed",
  ARCHIVED: "Archived",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium",
        statusStyles[status] ?? statusStyles["DRAFT"],
      )}
    >
      {statusLabels[status] ?? status}
    </span>
  );
}
