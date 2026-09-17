"use client";

import { useEffect, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type { ProjectProgressEvent } from "@clipforge/shared-types";
import { API_URL } from "./api";

let socket: Socket | null = null;

function getSocket(): Socket {
  socket ??= io(`${API_URL}/events`, {
    withCredentials: true,
    autoConnect: true,
  });
  return socket;
}

/**
 * Subscribes to live pipeline progress for one project. Falls back
 * gracefully (returns null) when the socket can't connect — pages
 * should keep polling query invalidation as a backup.
 */
export function useProjectProgress(
  projectId: string | undefined,
  onEvent?: (event: ProjectProgressEvent) => void,
): ProjectProgressEvent | null {
  const [latest, setLatest] = useState<ProjectProgressEvent | null>(null);

  useEffect(() => {
    if (!projectId) return;
    const s = getSocket();
    s.emit("subscribe:project", { projectId });
    const handler = (event: ProjectProgressEvent) => {
      if (event.projectId !== projectId) return;
      setLatest(event);
      onEvent?.(event);
    };
    s.on("project:progress", handler);
    return () => {
      s.off("project:progress", handler);
      s.emit("unsubscribe:project", { projectId });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  return latest;
}
