"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  FolderOpen,
  Film,
  Download,
  Activity,
  Coins,
  Plus,
} from "lucide-react";
import type { DashboardStats } from "@clipforge/shared-types";
import { api } from "@/lib/api";
import type { ProjectListResponse } from "@/lib/types";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ProjectCard } from "@/components/projects/project-card";

const statCards = [
  { key: "totalProjects", label: "Projects", icon: FolderOpen },
  { key: "totalClips", label: "Generated clips", icon: Film },
  { key: "completedExports", label: "Exports", icon: Download },
  { key: "processingJobs", label: "Processing", icon: Activity },
  { key: "remainingCredits", label: "Credits left", icon: Coins },
] as const;

export default function DashboardPage() {
  const { data: stats } = useQuery({
    queryKey: ["dashboard-stats"],
    queryFn: () => api<DashboardStats>("/dashboard/stats"),
  });
  const { data: projects } = useQuery({
    queryKey: ["projects", { recent: true }],
    queryFn: () => api<ProjectListResponse>("/projects?page=1&pageSize=6"),
  });

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-sm text-muted">
            Overview of your projects and processing activity.
          </p>
        </div>
        <Link href="/projects/new">
          <Button>
            <Plus className="h-4 w-4" />
            New project
          </Button>
        </Link>
      </div>

      <div className="mb-10 grid grid-cols-2 gap-4 lg:grid-cols-5">
        {statCards.map(({ key, label, icon: Icon }) => (
          <Card key={key} className="p-4">
            <div className="flex items-center gap-2 text-muted">
              <Icon className="h-4 w-4" />
              <span className="text-xs font-medium">{label}</span>
            </div>
            <p className="mt-2 text-2xl font-bold">
              {stats ? stats[key] : "—"}
            </p>
          </Card>
        ))}
      </div>

      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Recent projects</h2>
        <Link href="/projects" className="text-sm text-primary hover:underline">
          View all
        </Link>
      </div>
      {projects && projects.items.length === 0 ? (
        <Card className="flex flex-col items-center py-12 text-center">
          <Film className="mb-3 h-8 w-8 text-muted" />
          <p className="font-medium">No projects yet</p>
          <p className="mb-4 mt-1 text-sm text-muted">
            Import a video you own or are authorized to use, and let the AI find
            the best moments.
          </p>
          <Link href="/projects/new">
            <Button>
              <Plus className="h-4 w-4" />
              Create your first project
            </Button>
          </Link>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {projects?.items.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      )}
    </div>
  );
}
