"use client";

import { create } from "zustand";
import type { AuthUser } from "@clipforge/shared-types";
import { api, ApiError } from "./api";

interface AuthState {
  user: AuthUser | null;
  /** true until the first /auth/me round-trip resolves */
  loading: boolean;
  loadSession: () => Promise<void>;
  setUser: (user: AuthUser | null) => void;
  logout: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  loading: true,
  loadSession: async () => {
    try {
      const { user } = await api<{ user: AuthUser }>("/auth/me");
      set({ user, loading: false });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        set({ user: null, loading: false });
      } else {
        // API unreachable — treat as signed out but stop the spinner
        set({ user: null, loading: false });
      }
    }
  },
  setUser: (user) => set({ user, loading: false }),
  logout: async () => {
    try {
      await api("/auth/logout", { method: "POST", skipRefresh: true });
    } finally {
      set({ user: null });
    }
  },
}));
