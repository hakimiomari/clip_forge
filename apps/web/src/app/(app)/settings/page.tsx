"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Coins, KeyRound, UserRound } from "lucide-react";
import type { AuthUser } from "@clipforge/shared-types";
import { api, ApiError } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import { formatRelativeTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Input, Label, FieldError } from "@/components/ui/input";

interface CreditHistory {
  balance: number;
  items: Array<{
    id: string;
    amount: number;
    reason: string;
    createdAt: string;
  }>;
  total: number;
}

const REASON_LABELS: Record<string, string> = {
  IMPORT_VIDEO: "Video import",
  GENERATE_HIGHLIGHTS: "Highlight generation",
  RENDER_CLIP: "Clip render",
  PLAN_GRANT: "Credit grant",
  ADMIN_ADJUSTMENT: "Admin adjustment",
  REFUND: "Refund",
};

export default function SettingsPage() {
  const { user, setUser } = useAuthStore();
  const queryClient = useQueryClient();

  const [name, setName] = useState(user?.name ?? "");
  const [profileMsg, setProfileMsg] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordMsg, setPasswordMsg] = useState<string | null>(null);
  const [passwordErr, setPasswordErr] = useState<string | null>(null);

  const { data: credits } = useQuery({
    queryKey: ["credit-history"],
    queryFn: () => api<CreditHistory>("/users/me/credits?pageSize=25"),
  });

  const saveProfile = useMutation({
    mutationFn: () =>
      api<{ user: AuthUser }>("/users/me", {
        method: "PATCH",
        body: { name },
      }),
    onSuccess: (data) => {
      setUser({ ...(user as AuthUser), ...data.user });
      setProfileMsg("Saved ✓");
      setTimeout(() => setProfileMsg(null), 2500);
    },
  });

  const changePassword = useMutation({
    mutationFn: () =>
      api("/users/me/password", {
        method: "POST",
        body: { currentPassword, newPassword },
      }),
    onSuccess: () => {
      setPasswordErr(null);
      setPasswordMsg("Password updated — other sessions were signed out.");
      setCurrentPassword("");
      setNewPassword("");
      void queryClient.invalidateQueries();
    },
    onError: (e) => {
      setPasswordMsg(null);
      setPasswordErr(e instanceof ApiError ? e.message : String(e));
    },
  });

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-2xl font-bold tracking-tight">Settings</h1>
      <p className="mb-8 text-sm text-muted">
        Your profile, security and credit usage.
      </p>

      <div className="space-y-6">
        <Card>
          <div className="mb-4 flex items-center gap-2">
            <UserRound className="h-5 w-5 text-primary" />
            <CardTitle>Profile</CardTitle>
          </div>
          <div className="space-y-4">
            <div>
              <Label>Email</Label>
              <Input value={user?.email ?? ""} disabled />
            </div>
            <div>
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
              />
            </div>
            <div className="flex items-center gap-3">
              <Button
                loading={saveProfile.isPending}
                onClick={() => saveProfile.mutate()}
              >
                Save profile
              </Button>
              {profileMsg && (
                <span className="text-sm text-success">{profileMsg}</span>
              )}
            </div>
          </div>
        </Card>

        <Card>
          <div className="mb-4 flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-primary" />
            <CardTitle>Change password</CardTitle>
          </div>
          <div className="space-y-4">
            <div>
              <Label htmlFor="current">Current password</Label>
              <Input
                id="current"
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="new">New password (min 8 characters)</Label>
              <Input
                id="new"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </div>
            <FieldError message={passwordErr ?? undefined} />
            {passwordMsg && <p className="text-sm text-success">{passwordMsg}</p>}
            <Button
              variant="secondary"
              loading={changePassword.isPending}
              disabled={!currentPassword || newPassword.length < 8}
              onClick={() => changePassword.mutate()}
            >
              Update password
            </Button>
          </div>
        </Card>

        <Card>
          <div className="mb-1 flex items-center gap-2">
            <Coins className="h-5 w-5 text-warning" />
            <CardTitle>Credits</CardTitle>
          </div>
          <CardDescription>
            Balance:{" "}
            <span className="font-semibold text-foreground">
              {credits?.balance ?? user?.creditBalance ?? "—"}
            </span>{" "}
            · Imports cost 1, highlight generation 2, renders 2 per 30s.
            Failed jobs are refunded automatically.
          </CardDescription>
          <div className="mt-4 divide-y divide-border">
            {credits?.items.length === 0 && (
              <p className="py-3 text-sm text-muted">No transactions yet.</p>
            )}
            {credits?.items.map((t) => (
              <div key={t.id} className="flex items-center justify-between py-2.5 text-sm">
                <div>
                  <p className="font-medium">
                    {REASON_LABELS[t.reason] ?? t.reason}
                  </p>
                  <p className="text-xs text-muted">
                    {formatRelativeTime(t.createdAt)}
                  </p>
                </div>
                <span
                  className={
                    t.amount > 0 ? "font-semibold text-success" : "font-semibold text-danger"
                  }
                >
                  {t.amount > 0 ? `+${t.amount}` : t.amount}
                </span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
