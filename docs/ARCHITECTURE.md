# ClipForge AI — Architecture

## System overview

```
                    ┌───────────────────────────┐
                    │        Next.js (web)      │
                    │  dashboard · import · editor │
                    └─────────┬───────────┬─────┘
                       REST + cookies   Socket.IO
                    ┌─────────▼───────────▼─────┐
                    │        NestJS (api)       │
                    │ auth · projects · uploads │
                    │ credits · events gateway  │
                    └──┬─────────┬──────────┬───┘
                       │         │          │ presigned URLs
                 PostgreSQL    Redis    Object storage (S3/MinIO)
                 (Prisma)    (BullMQ +      videos · audio ·
                       ▲      pub/sub)   thumbnails · exports
                       │         │                ▲
                    ┌──┴─────────▼────────────────┴──┐
                    │          Worker (BullMQ)       │
                    │ video-import · transcription*  │
                    │ highlights* · render* · cleanup│
                    │        FFmpeg / FFprobe        │
                    └────────────────────────────────┘
                                          * = upcoming milestones
```

Three processes, strictly separated:

1. **`apps/web`** — Next.js App Router UI. Talks to the API with `credentials: include` (httpOnly cookies) and subscribes to progress over Socket.IO.
2. **`apps/api`** — NestJS. Owns the database, authentication, authorization, credit accounting and queue *production*. Never does media work: long-running jobs are enqueued, not executed, in HTTP handlers.
3. **`apps/worker`** — plain Node process consuming BullMQ queues. Does all FFmpeg/AI work, updates the database, and publishes progress events to a Redis pub/sub channel that the API relays to browsers.

## Key decisions

| Decision | Rationale |
| --- | --- |
| pnpm workspaces, no Turborepo | Three apps + two packages don't need a build graph yet; `pnpm -r`/`--filter` covers it. Turbo can be added without restructuring. |
| Cookie-based JWT (access 15 min + rotating refresh 7 d) | Keeps tokens out of JavaScript (XSS-resistant), satisfies the "secure cookies" requirement; Bearer header also accepted for API clients. Refresh tokens are stored hashed; reuse of a rotated token revokes the whole family. |
| bcryptjs for password hashing | Pure-JS, no native build issues on Windows dev machines; cost 12. Swappable for argon2 in production images. |
| Presigned direct-to-storage uploads | The API never proxies gigabytes; the browser PUTs straight to MinIO/S3 with a scoped, time-limited URL. Upload keys are namespaced `users/{userId}/…` and the import endpoint rejects keys outside the caller's prefix. |
| Raw BullMQ (no @nestjs/bullmq) | The API only *adds* jobs; a thin `QueuesService` avoids version coupling. The worker registers processors from a simple registry table. |
| Progress via Redis pub/sub → Socket.IO rooms | Worker stays framework-free; the API's `EventsGateway` authenticates sockets with the access token and only lets owners join `project:{id}` rooms. The UI also polls while processing as a fallback. |
| YouTube = stream, never store | Import reads metadata only (`yt-dlp --dump-single-json`). Highlight analysis resolves CDN stream URLs (`yt-dlp -g`) and ffmpeg reads the audio-only and ≤360p video streams directly over HTTP. Rendering fetches just the clip's window (`yt-dlp --download-sections`, keyframes forced at the cut) into a temp dir. All spawns are argv-only, no shell. The user's rights declaration is required at import. |
| JSON columns versioned (`Timeline.version`, `Clip.planVersion`) | Editor and render formats will evolve; persisted documents carry their schema version for forward migration. |
| Credits as a ledger (`CreditTransaction`) + cached balance | Balance updates use a conditional decrement (no overdraw under concurrency); every spend/grant is auditable, refunds on failed job setup. |

## Ownership & security model

- Every entity reaches a `userId` directly or through its `Project`. All reads/writes go through `ProjectsService.getOwned()`, which answers **404** (not 403) for foreign projects so IDs can't be probed.
- Global `JwtAuthGuard` (opt-out via `@Public()`), global rate limiting (`@nestjs/throttler`, tighter on auth routes), `helmet`, strict DTO validation (`whitelist + forbidNonWhitelisted`).
- Storage objects are private; access is exclusively via short-lived presigned URLs. Export downloads will use `ResponseContentDisposition` attachment URLs.
- Worker jobs carry `{projectId, userId}` and re-verify ownership before touching data.

## Data model (ERD summary)

```
User 1─* Project 1─1 VideoSource
              1─1 Transcript 1─* TranscriptSegment
              1─* Highlight 1─* Clip
              1─* Clip ──1 Timeline (versioned JSON)
                       ──* Caption
                       ──* RenderJob
                       ──* Export
User 1─* RefreshToken / CreditTransaction / Template
User 1─1 Subscription
```

Statuses: `Project` DRAFT → IMPORTING → IMPORTED → ANALYZING → GENERATING_HIGHLIGHTS → READY → RENDERING → COMPLETED (or FAILED/ARCHIVED); `Clip` DRAFT → EDITING → RENDER_QUEUED → RENDERING → RENDERED; `RenderJob` PENDING → RUNNING → COMPLETED/FAILED/CANCELLED.

## Processing pipeline (target state)

```
Import (FFprobe, thumbnail, audio)     ← Milestone 1 (done)
   → Transcription (segments + timestamps)      ← M2
   → Highlight generation (LLM scoring)         ← M2
   → Clip creation (editing plan → timeline)    ← M3
   → Caption generation                         ← M3
   → Render (FFmpeg filtergraph / Remotion)     ← M3
   → Quality check → Export → signed download   ← M3
```

Each stage is a BullMQ queue (`packages/shared-types/src/queues.ts` is the single source of queue names and payload types). Jobs are idempotent and resumable: payloads carry IDs only, state lives in PostgreSQL.

## AI agent mapping

The PRD's agents map to worker processors + a provider abstraction (`AI_PROVIDER` env):

| Agent | Home | Milestone |
| --- | --- | --- |
| Video Intake | `video-import.processor.ts` | 1 ✅ |
| Transcript | `transcription.processor.ts` + provider adapter | 2 |
| Scene Analysis | `scene-analysis.processor.ts` (FFmpeg scene scores) | 2/3 |
| Highlight Selection | `highlight.processor.ts` + LLM (configurable weights) | 2 |
| Editing Plan | `clip-generation.processor.ts` → `EditingPlan` JSON | 3 |
| Caption | `caption-generation.processor.ts` | 3 |
| Rendering | `render.processor.ts` (FFmpeg; Remotion for animated captions) | 3 |
| Quality Control | `quality-check.processor.ts` (duration/black-frame/audio checks) | 3 |

## Storage layout

```
users/{userId}/
├── uploads/{uuid}/{filename}              raw browser uploads
└── projects/{projectId}/
    ├── thumbnails/source.jpg
    ├── audio/source.m4a                   16 kHz mono for transcription
    ├── previews/…                         (M3)
    └── exports/{exportId}.mp4             (M3)
```
