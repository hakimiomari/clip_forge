"use client";

import { useState, useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useAuthStore } from "@/lib/auth-store";

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 10_000,
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  const loadSession = useAuthStore((s) => s.loadSession);
  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
