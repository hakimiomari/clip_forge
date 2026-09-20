# ClipForge AI — API reference (Milestone 1)

Base URL: `http://localhost:4000` · Interactive docs: `/docs` (Swagger)

Authentication: httpOnly cookies (`cf_access`, `cf_refresh`) set by the auth
endpoints; `Authorization: Bearer <token>` is also accepted. All endpoints
require auth unless marked **public**. Errors follow Nest's shape:
`{ statusCode, message, error }`; credit shortfalls return **402** with
`code: "INSUFFICIENT_CREDITS"`.

## Auth

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/auth/register` | public — `{name?, email, password}` → sets cookies, returns `{user}` |
| POST | `/auth/login` | public — `{email, password}` → sets cookies, returns `{user}` |
| POST | `/auth/refresh` | public — rotates the refresh token from the cookie |
| POST | `/auth/logout` | public — revokes the refresh token, clears cookies |
| GET | `/auth/me` | current user `{user: {id, email, name, role, plan, creditBalance}}` |

## Uploads

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/uploads/presign` | `{fileName, contentType, sizeBytes}` → `{uploadUrl, storageKey, expiresIn}`. Browser then `PUT`s the file to `uploadUrl` with the same `Content-Type`. Allowed types: mp4, mov, mkv, webm ≤ 4 GB. |

## Projects

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/projects` | `{name?}` → project (status `DRAFT`) |
| GET | `/projects?page=&pageSize=` | paginated `{items, total, page, pageSize}` |
| GET | `/projects/:id` | detail incl. source, highlights, clips, presigned `mediaUrl` |
| PATCH | `/projects/:id` | `{name?}` |
| DELETE | `/projects/:id` | 204 — cascades DB rows, queues storage cleanup |
| POST | `/projects/:id/import` | attach source & start pipeline (see below) |
| GET | `/projects/:id/source` | source details + presigned `mediaUrl` |

### Import body

```jsonc
// Upload flow (after PUT to presigned URL)
{
  "sourceType": "UPLOAD",
  "storageKey": "users/<userId>/uploads/…",   // must be your own prefix
  "rights": "OWNED",                           // OWNED | LICENSED | CREATIVE_COMMONS | PUBLIC_DOMAIN | PERMISSION_GRANTED
  "rightsNote": "optional attribution",
  "rightsConfirmed": true                      // must be true
}

// YouTube flow (metadata import; analysis streams the video, renders fetch only the clip window)
{
  "sourceType": "YOUTUBE",
  "url": "https://www.youtube.com/watch?v=…",
  "rights": "PERMISSION_GRANTED",
  "rightsConfirmed": true
}
```

Costs 1 credit. Project moves `DRAFT → IMPORTING`; the worker sets
`IMPORTED` (or `FAILED` with a friendly `error`).

## Dashboard

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/dashboard/stats` | `{totalProjects, totalClips, completedExports, processingJobs, remainingCredits}` |

## Health

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/health` | public — `{status, database, timestamp}` |

## Realtime events (Socket.IO)

Namespace `/events` at the API origin, `withCredentials: true`.

- Emit `subscribe:project` `{projectId}` → ack `{ok}` (ownership enforced)
- Listen `project:progress` → `{projectId, status, progress, step, error?}`
- Emit `unsubscribe:project` `{projectId}` when leaving

## Planned (M2/M3 — per PRD)

`POST /projects/:id/highlights/generate`, `GET /projects/:id/highlights`,
`POST /highlights/:id/create-clip`, `GET/PATCH /clips/:id(/timeline)`,
`POST /clips/:id/render`, `GET /clips/:id/render-status`,
`POST /clips/:id/export`, `GET /clips/:id/download`,
`GET /projects/:id/exports`, `DELETE /exports/:id`.
