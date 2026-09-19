"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Users,
  FolderOpen,
  Film,
  Download,
  Activity,
  AlertTriangle,
  ShieldCheck,
  Coins,
  RefreshCcw,
} from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import { cn, formatRelativeTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, FieldError } from "@/components/ui/input";

interface AdminStats {
  totalUsers: number;
  totalProjects: number;
  totalClips: number;
  totalExports: number;
  failedProjects: number;
  processingProjects: number;
  renderJobs: Record<string, number>;
  creditsSpent: number;
}

interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  role: string;
  plan: string;
  creditBalance: number;
  suspended: boolean;
  projectCount: number;
  createdAt: string;
}

interface AdminJobs {
  failedRenders: Array<{
    id: string;
    error: string | null;
    createdAt: string;
    clip: { id: string; name: string | null; project?: { name: string } };
  }>;
  failedProjects: Array<{
    id: string;
    name: string;
    error: string | null;
    updatedAt: string;
  }>;
}

export default function AdminPage() {
  const router = useRouter();
  const { user, loading } = useAuthStore();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);

  const isAdmin = user?.role === "ADMIN";
  useEffect(() => {
    if (!loading && !isAdmin) router.replace("/dashboard");
  }, [loading, isAdmin, router]);

  const { data: stats } = useQuery({
    queryKey: ["admin-stats"],
    queryFn: () => api<AdminStats>("/admin/stats"),
    enabled: isAdmin,
  });
  const { data: users } = useQuery({
    queryKey: ["admin-users", search],
    queryFn: () =>
      api<{ items: AdminUser[]; total: number }>(
        `/admin/users?pageSize=50${search ? `&query=${encodeURIComponent(search)}` : ""}`,
      ),
    enabled: isAdmin,
  });
  const { data: jobs } = useQuery({
    queryKey: ["admin-jobs"],
    queryFn: () => api<AdminJobs>("/admin/jobs"),
    enabled: isAdmin,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["admin-stats"] });
    void queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    void queryClient.invalidateQueries({ queryKey: ["admin-jobs"] });
  };
  const onError = (e: unknown) =>
    setError(e instanceof ApiError ? e.message : String(e));

  const adjustCredits = useMutation({
    mutationFn: ({ id, amount }: { id: string; amount: number }) =>
      api(`/admin/users/${id}/credits`, { method: "POST", body: { amount } }),
    onSuccess: refresh,
    onError,
  });
  const updateUser = useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Record<string, unknown>) =>
      api(`/admin/users/${id}`, { method: "PATCH", body }),
    onSuccess: refresh,
    onError,
  });
  const retryJob = useMutation({
    mutationFn: (id: string) =>
      api(`/admin/render-jobs/${id}/retry`, { method: "POST" }),
    onSuccess: refresh,
    onError,
  });

  if (loading || !isAdmin) return null;

  const statCards = [
    { label: "Users", value: stats?.totalUsers, icon: Users },
    { label: "Projects", value: stats?.totalProjects, icon: FolderOpen },
    { label: "Clips", value: stats?.totalClips, icon: Film },
    { label: "Exports", value: stats?.totalExports, icon: Download },
    { label: "Processing", value: stats?.processingProjects, icon: Activity },
    { label: "Failed projects", value: stats?.failedProjects, icon: AlertTriangle },
    { label: "Credits spent", value: stats?.creditsSpent, icon: Coins },
  ];

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-8 flex items-center gap-2">
        <ShieldCheck className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Admin</h1>
          <p className="text-sm text-muted">
            Users, credits and processing jobs across the platform.
          </p>
        </div>
      </div>

      <FieldError message={error ?? undefined} />

      <div className="mb-8 grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">
        {statCards.map(({ label, value, icon: Icon }) => (
          <Card key={label} className="p-3">
            <div className="flex items-center gap-1.5 text-muted">
              <Icon className="h-3.5 w-3.5" />
              <span className="text-[11px] font-medium">{label}</span>
            </div>
            <p className="mt-1 text-xl font-bold">{value ?? "—"}</p>
          </Card>
        ))}
      </div>

      <Card className="mb-8 p-0">
        <div className="flex items-center justify-between border-b border-border p-4">
          <CardTitle>Users {users ? `(${users.total})` : ""}</CardTitle>
          <Input
            placeholder="Search email or name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-60"
          />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted">
                <th className="px-4 py-2 font-medium">User</th>
                <th className="px-2 py-2 font-medium">Role</th>
                <th className="px-2 py-2 font-medium">Plan</th>
                <th className="px-2 py-2 font-medium">Projects</th>
                <th className="px-2 py-2 font-medium">Credits</th>
                <th className="px-2 py-2 font-medium">Joined</th>
                <th className="px-4 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users?.items.map((u) => (
                <tr
                  key={u.id}
                  className={cn(
                    "border-b border-border/60",
                    u.suspended && "opacity-50",
                  )}
                >
                  <td className="px-4 py-2.5">
                    <p className="font-medium">{u.name ?? "—"}</p>
                    <p className="text-xs text-muted">{u.email}</p>
                  </td>
                  <td className="px-2 py-2.5">
                    <select
                      value={u.role}
                      disabled={u.id === user?.id}
                      onChange={(e) =>
                        updateUser.mutate({ id: u.id, role: e.target.value })
                      }
                      className="rounded border border-border bg-surface px-1.5 py-1 text-xs"
                    >
                      <option value="USER">USER</option>
                      <option value="ADMIN">ADMIN</option>
                    </select>
                  </td>
                  <td className="px-2 py-2.5">
                    <select
                      value={u.plan}
                      onChange={(e) =>
                        updateUser.mutate({ id: u.id, plan: e.target.value })
                      }
                      className="rounded border border-border bg-surface px-1.5 py-1 text-xs"
                    >
                      {["FREE", "STARTER", "PRO", "BUSINESS"].map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-2.5">{u.projectCount}</td>
                  <td className="px-2 py-2.5">
                    <div className="flex items-center gap-1">
                      <span className="min-w-10 font-semibold">
                        {u.creditBalance}
                      </span>
                      <button
                        title="Add 50 credits"
                        className="rounded border border-border px-1.5 text-xs text-success hover:bg-success/10"
                        onClick={() =>
                          adjustCredits.mutate({ id: u.id, amount: 50 })
                        }
                      >
                        +50
                      </button>
                      <button
                        title="Remove 50 credits"
                        className="rounded border border-border px-1.5 text-xs text-danger hover:bg-danger/10"
                        onClick={() =>
                          adjustCredits.mutate({ id: u.id, amount: -50 })
                        }
                      >
                        −50
                      </button>
                    </div>
                  </td>
                  <td className="px-2 py-2.5 text-xs text-muted">
                    {formatRelativeTime(u.createdAt)}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <Button
                      size="sm"
                      variant={u.suspended ? "secondary" : "danger"}
                      disabled={u.id === user?.id}
                      onClick={() =>
                        updateUser.mutate({ id: u.id, suspended: !u.suspended })
                      }
                    >
                      {u.suspended ? "Reinstate" : "Suspend"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardTitle className="mb-3">Failed renders</CardTitle>
          {jobs?.failedRenders.length === 0 && (
            <p className="text-sm text-muted">Nothing failed. 🎉</p>
          )}
          <div className="space-y-3">
            {jobs?.failedRenders.map((j) => (
              <div
                key={j.id}
                className="rounded-lg border border-danger/20 bg-danger/5 p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {j.clip.name ?? j.clip.id}
                    </p>
                    <p className="mt-0.5 line-clamp-2 text-xs text-danger">
                      {j.error ?? "unknown error"}
                    </p>
                    <p className="mt-0.5 text-xs text-muted">
                      {formatRelativeTime(j.createdAt)}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={retryJob.isPending}
                    onClick={() => retryJob.mutate(j.id)}
                  >
                    <RefreshCcw className="h-3.5 w-3.5" />
                    Retry
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <CardTitle className="mb-3">Failed projects</CardTitle>
          {jobs?.failedProjects.length === 0 && (
            <p className="text-sm text-muted">Nothing failed. 🎉</p>
          )}
          <div className="space-y-3">
            {jobs?.failedProjects.map((p) => (
              <div
                key={p.id}
                className="rounded-lg border border-danger/20 bg-danger/5 p-3"
              >
                <p className="truncate text-sm font-medium">{p.name}</p>
                <p className="mt-0.5 line-clamp-2 text-xs text-danger">
                  {p.error ?? "unknown error"}
                </p>
                <p className="mt-0.5 text-xs text-muted">
                  {formatRelativeTime(p.updatedAt)}
                </p>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
