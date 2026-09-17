import { cn } from "@/lib/utils";

export function ProgressBar({
  value,
  label,
  className,
}: {
  value: number;
  label?: string;
  className?: string;
}) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div className={cn("w-full", className)}>
      {label && (
        <div className="mb-1.5 flex items-center justify-between text-xs text-muted">
          <span>{label}</span>
          <span>{Math.round(clamped)}%</span>
        </div>
      )}
      <div className="h-2 w-full overflow-hidden rounded-full bg-surface-raised">
        <div
          className="h-full rounded-full bg-gradient-to-r from-primary to-accent transition-all duration-500"
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}
