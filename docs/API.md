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
| POST | `/projects/:id/highlights/generate` | find moments: `{clipDuration, clipCount, format?, editingStyle?, captionStyle?, useTranscript?}` (2 credits). Add `autoCreateClips: true` (plus `captionsEnabled?`, `zoomEnabled?`, `backgroundMode?`, `ctaEnabled?`) for **automatic mode**: the worker also builds and renders a short per moment. Automatic mode pre-charges `2 + clipCount × renderCost(clipDuration)` and returns `{creditsCharged}`; shorts that can't be produced are refunded by the worker |
| GET | `/projects/:id/filmstrip` | timeline frame sprite: `{status, url, count, columns, rows, frameWidth, frameHeight, interval}`. `status` is `NONE \| PENDING \| READY \| FAILED`; `url` is presigned and set only when `READY` |
| POST | `/projects/:id/filmstrip` | 202 — queues sprite generation (no-op while `PENDING`/`READY`, retries after `FAILED`) |
| POST | `/projects/:id/clips` | clip from the timeline: either one range (`{sourceStart, sourceEnd, …}`) or **several parts** stitched in order (`{segments: [{sourceStart, sourceEnd}, …], …}`, max 12), plus `{name?, format, captionsEnabled, captionStyle, zoomEnabled, backgroundMode?, ctaEnabled?}`. Charges the render cost and queues the render, like `create-clip`. Each part ≥ 0.5 s, total 5–240 s; ranges are used as given, never widened |

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

## Planned

`POST /clips/:id/export`, `DELETE /exports/:id`, and a persisted
multi-track `GET/PATCH /clips/:id/timeline` (today's timeline selects a
single source range; the `Timeline` table is reserved for that work).
