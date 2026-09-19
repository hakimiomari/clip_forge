"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Clapperboard,
  LayoutDashboard,
  FolderOpen,
  Loader2,
  LogOut,
  Coins,
  Settings,
  ShieldCheck,
} from "lucide-react";
import { useAuthStore } from "@/lib/auth-store";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/projects", label: "Projects", icon: FolderOpen },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { user, loading, logout } = useAuthStore();

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  if (loading || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen">
      <aside className="fixed inset-y-0 flex w-60 flex-col border-r border-border bg-surface px-4 py-6">
        <Link href="/dashboard" className="mb-8 flex items-center gap-2 px-2">
          <Clapperboard className="h-6 w-6 text-primary" />
          <span className="text-lg font-bold tracking-tight">ClipForge AI</span>
        </Link>
        <nav className="flex flex-1 flex-col gap-1">
          {navItems.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                pathname.startsWith(href)
                  ? "bg-primary/10 text-primary"
                  : "text-muted hover:bg-surface-raised hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
            </Link>
          ))}
          {user.role === "ADMIN" && (
            <Link
              href="/admin"
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                pathname.startsWith("/admin")
                  ? "bg-primary/10 text-primary"
                  : "text-muted hover:bg-surface-raised hover:text-foreground",
              )}
            >
              <ShieldCheck className="h-4 w-4" />
              Admin
            </Link>
          )}
        </nav>
        <div className="space-y-3 border-t border-border pt-4">
          <div className="flex items-center gap-2 px-2 text-sm text-muted">
            <Coins className="h-4 w-4 text-warning" />
            <span>
              <span className="font-semibold text-foreground">
                {user.creditBalance}
              </span>{" "}
              credits
            </span>
          </div>
          <Link
            href="/settings"
            title="Account settings"
            className={cn(
              "group flex items-center justify-between rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-raised",
              pathname.startsWith("/settings") && "bg-primary/10",
            )}
          >
            <div className="min-w-0">
              <p
                className={cn(
                  "truncate text-sm font-medium group-hover:text-primary",
                  pathname.startsWith("/settings") && "text-primary",
                )}
              >
                {user.name ?? user.email}
              </p>
              <p className="truncate text-xs text-muted">{user.email}</p>
            </div>
            <Settings className="h-4 w-4 shrink-0 text-muted group-hover:text-primary" />
          </Link>
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start"
            onClick={async () => {
              await logout();
              router.replace("/login");
            }}
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </Button>
        </div>
      </aside>
      <main className="ml-60 flex-1 px-8 py-8">{children}</main>
    </div>
  );
}
