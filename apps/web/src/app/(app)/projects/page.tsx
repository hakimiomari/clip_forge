"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Plus, Film } from "lucide-react";
import { api } from "@/lib/api";
import type { ProjectListResponse } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ProjectCard } from "@/components/projects/project-card";

const PAGE_SIZE = 12;

export default function ProjectsPage() {
  const [page, setPage] = useState(1);
  const { data, isLoading } = useQuery({
    queryKey: ["projects", { page }],
    queryFn: () =>
      api<ProjectListResponse>(`/projects?page=${page}&pageSize=${PAGE_SIZE}`),
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Projects</h1>
          <p className="mt-1 text-sm text-muted">
            {data ? `${data.total} project${data.total === 1 ? "" : "s"}` : "…"}
          </p>
        </div>
        <Link href="/projects/new">
          <Button>
            <Plus className="h-4 w-4" />
            New project
          </Button>
        </Link>
      </div>

      {!isLoading && data?.items.length === 0 ? (
        <Card className="flex flex-col items-center py-16 text-center">
          <Film className="mb-3 h-8 w-8 text-muted" />
          <p className="font-medium">No projects yet</p>
          <p className="mb-4 mt-1 text-sm text-muted">
            Create a project to import your first video.
          </p>
          <Link href="/projects/new">
            <Button>
              <Plus className="h-4 w-4" />
              New project
            </Button>
          </Link>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {data?.items.map((project) => (
              <ProjectCard key={project.id} project={project} />
            ))}
          </div>
          {totalPages > 1 && (
            <div className="mt-8 flex items-center justify-center gap-3">
              <Button
                variant="secondary"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </Button>
              <span className="text-sm text-muted">
                Page {page} of {totalPages}
              </span>
              <Button
                variant="secondary"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
