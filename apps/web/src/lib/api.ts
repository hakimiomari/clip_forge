/**
 * Minimal typed API client. Auth uses httpOnly cookies, so every request
 * is sent with credentials; a 401 triggers one silent refresh + retry.
 */

export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  /** Skip the automatic refresh-and-retry (used by auth calls themselves) */
  skipRefresh?: boolean;
}

async function rawRequest(path: string, options: RequestOptions): Promise<Response> {
  return fetch(`${API_URL}${path}`, {
    method: options.method ?? "GET",
    credentials: "include",
    headers:
      options.body !== undefined
        ? { "Content-Type": "application/json" }
        : undefined,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
}

let refreshPromise: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  refreshPromise ??= (async () => {
    try {
      const res = await rawRequest("/auth/refresh", {
        method: "POST",
        skipRefresh: true,
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let response = await rawRequest(path, options);

  if (response.status === 401 && !options.skipRefresh) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      response = await rawRequest(path, options);
    }
  }

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    let code: string | undefined;
    try {
      const data = await response.json();
      message = Array.isArray(data.message)
        ? data.message.join(", ")
        : (data.message ?? message);
      code = data.code;
    } catch {
      // non-JSON error body
    }
    throw new ApiError(response.status, message, code);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
