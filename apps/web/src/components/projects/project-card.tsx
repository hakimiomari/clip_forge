"use client";

import Link from "next/link";
import { Film, Clock } from "lucide-react";
import type { ProjectSummary } from "@clipforge/shared-types";
import { StatusBadge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { formatDuration, formatRelativeTime } from "@/lib/utils";

export function ProjectCard({ project }: { project: ProjectSummary }) {
  return (
    <Link href={`/projects/${project.id}`}>
      <Card className="group cursor-pointer overflow-hidden p-0 transition-colors hover:border-border-strong">
        <div className="relative aspect-video w-full bg-surface-raised">
          {project.source?.thumbnailUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={project.source.thumbnailUrl}
              alt=""
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full items-center justify-center">
              <Film className="h-8 w-8 text-border-strong" />
            </div>
          )}
          {project.source?.duration != null && (
            <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-xs font-medium">
              {formatDuration(project.source.duration)}
            </span>
          )}
        </div>
        <div className="p-4">
          <div className="mb-2 flex items-start justify-between gap-2">
            <h3 className="truncate font-semibold group-hover:text-primary">
              {project.name}
            </h3>
            <StatusBadge status={project.status} />
          </div>
          <div className="flex items-center gap-4 text-xs text-muted">
            <span className="flex items-center gap-1">
              <Film className="h-3.5 w-3.5" />
              {project.clipCount} clip{project.clipCount === 1 ? "" : "s"}
            </span>
            <span className="flex items-center gap-1">
              <Clock className="h-3.5 w-3.5" />
              {formatRelativeTime(project.updatedAt)}
            </span>
          </div>
        </div>
      </Card>
    </Link>
  );
}
