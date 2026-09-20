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
| Automatic mode finishes without the browser | "Make N shorts automatically" is one API call. The API pre-charges for the renders and the **worker** creates the clips and queues their renders once the moments are chosen, so the shorts still appear if the page is closed the moment the button is pressed. Both sides build the render recipe with the same `buildEditingPlan` from `shared-types`, so an automatic short and a hand-cut one are byte-identical recipes. Shorts that can't be produced (fewer good moments than requested) are refunded by the worker. |
| Stitch parts before rendering, not inside it | A clip can be cut from several source ranges. They are joined into one intermediate file first (each part seeked with `-ss` before its own `-i`, then `concat`), so captions, speed effects, the banner, background removal and QC all keep operating on one continuous clip and need no notion of parts. Single-part clips skip the join entirely, so the common case pays nothing for the feature. |
| Timeline frames as one sprite | The editor needs thumbnails along the track, but one request per frame would be dozens of round trips. A background job grabs 24–120 frames with independent `-ss` seeks (cheap range requests over a presigned S3 URL or a YouTube CDN stream — never a full download), tiles them into a single JPEG, and the browser positions that one image per cell. Generation is idempotent, costs no credits, and a failure only degrades the track to a plain bar. |
| YouTube = fetch what's needed, store nothing | Import reads metadata only (`yt-dlp --dump-single-json`). Analysis downloads the audio track and a ≤360p video track into the job's temp dir with `yt-dlp`, then reads them locally. Rendering fetches just the clip's windows (`yt-dlp --download-sections`, keyframes forced at the cut). Everything lands in a temp dir deleted when the job ends; only rendered clips reach storage. All spawns are argv-only, no shell, and the user's rights declaration is required at import. |
| Download before analysing, don't stream | Pointing ffmpeg at a YouTube CDN URL is throttled to roughly playback speed: reading a 25-minute video's audio took ~13 minutes at ~2% CPU, and a 3-hour source could not finish inside the timeout. `yt-dlp` fetches the same bytes in chunks — 30s for that audio — so analysis downloads first and decodes locally. Measured end to end on a 25-minute video: **~13+ min (unfinished) → 125s**. |
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
    ├── filmstrip/strip.jpg                timeline frame sprite (24–120 tiles)
    ├── audio/source.m4a                   16 kHz mono for transcription
    ├── previews/…                         (M3)
    └── exports/{exportId}.mp4             (M3)
```
