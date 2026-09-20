# ClipForge AI

AI-powered **video highlight generator & short-form video editor**. Upload a long video you own or are authorized to use — ClipForge analyzes it, finds the best moments, and renders polished vertical/square/landscape clips with captions, zoom, blurred backgrounds and fades, ready to download as MP4.

> ⚠️ ClipForge is **not** a copyright-bypass tool. Editing effects (cropping, zooming, mirroring, transitions) do not make copyrighted material safe to republish and do not guarantee Content ID avoidance. Every import requires the user to declare a rights basis. YouTube sources are never downloaded in full: the worker streams them for analysis and fetches only the seconds each clip needs (via yt-dlp/ffmpeg). Only import videos you own or are authorized to use, and note that accessing media this way may be restricted by YouTube's Terms of Service.

---

## Table of contents

1. [What it does](#what-it-does)
2. [Architecture](#architecture)
3. [Prerequisites](#prerequisites)
4. [Setup from scratch](#setup-from-scratch)
5. [Running the app](#running-the-app)
6. [Using ClipForge (walkthrough)](#using-clipforge-walkthrough)
7. [Credits](#credits)
8. [AI providers (optional)](#ai-providers-optional)
9. [Admin panel](#admin-panel)
10. [Configuration reference](#configuration-reference)
11. [Testing](#testing)
12. [Project structure](#project-structure)
13. [API overview](#api-overview)
14. [Troubleshooting](#troubleshooting)
15. [Roadmap](#roadmap)

---

## What it does

The working end-to-end flow today:

```
Upload video ──▶ Import (metadata, thumbnail, audio extract)
             ──▶ Analyze (transcript*, audio energy, silences, scene cuts)
             ──▶ AI highlight suggestions (scored, titled, explained)
             ──▶ Create clip (vertical 9:16 / square / landscape)
             ──▶ Render (blur background, zoom, fades, captions*, loudnorm)
             ──▶ Download MP4
```

\* Transcript and captions activate when a transcription API key is configured; everything else works fully offline via signal analysis.

Also included: authentication, dashboard, project history, live processing progress (WebSockets), a credit system with an auditable ledger and automatic refunds on failure, user settings (profile, password, credit history), and an admin panel.

## Architecture

Three processes + three infrastructure services:

| Piece | Tech | Role |
| --- | --- | --- |
| `apps/web` | Next.js 15, Tailwind v4, TanStack Query, Zustand | Dashboard, import wizard, highlights & clips UI |
| `apps/api` | NestJS 11, Prisma | Auth (httpOnly-cookie JWT + refresh rotation), projects, uploads, credits, admin, Socket.IO progress gateway, **queues jobs — never does media work** |
| `apps/worker` | Node + BullMQ | FFmpeg/AI pipeline: import, analysis, highlight selection, caption build, rendering |
| PostgreSQL | Docker | All persistent data (Prisma schema in `packages/database`) |
| Redis | Docker | BullMQ job queues + progress pub/sub |
| MinIO | Docker | S3-compatible private object storage; browser uploads/downloads use short-lived presigned URLs |

Deep dive: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · Endpoints: [docs/API.md](docs/API.md) · Plan: [docs/ROADMAP.md](docs/ROADMAP.md)

## Prerequisites

- **Node.js ≥ 22** and **pnpm** (`npm i -g pnpm`)
- **Docker Desktop** (PostgreSQL, Redis, MinIO run as containers)
- **FFmpeg + FFprobe** built with libass and fontconfig (needed for burned-in captions and the watermark). On macOS, Homebrew's lean `ffmpeg` lacks them — use `brew install ffmpeg-full` and set `FFMPEG_PATH=/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg` / `FFPROBE_PATH=…/ffprobe` in `.env`. The worker warns at startup if the `subtitles` or `drawtext` filter is missing.
- **yt-dlp** on your `PATH` (`brew install yt-dlp`) for YouTube sources — or set `YTDLP_PATH`

## Setup from scratch

```bash
# 1. Install dependencies
pnpm install
#    If pnpm asks about build scripts, they are pre-approved in
#    pnpm-workspace.yaml (prisma, esbuild — telemetry declined).

# 2. Create your environment file
cp .env.example .env
#    Generate real JWT secrets and paste them into .env:
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
#    (run twice: JWT_SECRET and JWT_REFRESH_SECRET)

# 3. Start infrastructure (PostgreSQL :5433, Redis :6380, MinIO :9000/:9001)
pnpm infra:up
#    A one-shot job creates the storage bucket automatically.

# 4. Prisma: generate client + apply migrations
pnpm db:generate
pnpm db:migrate
```

The Prisma CLI reads `packages/database/.env` — create it with the same `DATABASE_URL` as the root `.env` if it doesn't exist.

## Running the app

```bash
pnpm dev        # builds shared packages, then runs api + worker + web together
```

Or individually: `pnpm dev:api`, `pnpm dev:worker`, `pnpm dev:web`.

| Service | URL |
| --- | --- |
| Web app | http://localhost:3000 |
| API | http://localhost:4000 |
| API docs (Swagger) | http://localhost:4000/docs |
| MinIO console | http://localhost:9001 (user `clipforge`, password `clipforge-secret`) |
| Prisma Studio | `pnpm db:studio` |

Stop infrastructure with `pnpm infra:down` (data persists in Docker volumes).

## Using ClipForge (walkthrough)

1. **Register** at http://localhost:3000 (any email works in dev; new accounts get 20 credits).
2. **New project** → choose **Upload file** (MP4/MOV/MKV/WebM up to 4 GB), tick the rights confirmation, and create. The file goes straight to storage via a presigned URL; the worker probes it, makes a thumbnail, extracts audio, and marks the project **Imported** — progress streams live.
   - *YouTube URL* imports metadata in seconds (max 4 hours). Highlight analysis streams the audio and a low-res video feed through ffmpeg; each render fetches only that clip's window (best MP4 up to 1080p) with `yt-dlp`. Nothing from YouTube is stored except your rendered clips.
3. On the project page, use **Generate AI highlights**: pick clip length (30–120 s), number of suggestions and caption style → **Find the best moments** (2 credits). Watch the analysis progress live.
4. Each suggestion card shows a **score /100, title, time range, hook and the reason** it was selected. Click **Create clip** — the clip renders immediately (2 credits per 30 s).
5. On the clip card: watch render progress, then **preview** the video, **Download MP4**, **Edit** (format, captions on/off, caption style, zoom → *Save & re-render*), **Re-render**, or **Delete**.
6. Click **your name** at the bottom of the sidebar for settings: profile, password change, and your full credit history.

## Credits

| Action | Cost |
| --- | --- |
| Import video | 1 |
| Generate highlights | 2 |
| Render clip | 2 per 30 s (60 s → 4, 120 s → 8) |

Every change is a row in the `CreditTransaction` ledger. Spends are concurrency-safe (no negative balances — the API returns **402** when short). **Failed jobs refund automatically.** Admins can grant/remove credits from the admin panel. Purchasing (Stripe) is a roadmap item — in dev, top up via the admin panel.

## AI providers (optional)

Out of the box (no keys) ClipForge uses a **real offline heuristic**: audio-energy windows, silence and scene-cut detection, boundary snapping. Adding keys upgrades quality:

```dotenv
# LLM highlight selection (titles, hooks, rubric-based scoring from the transcript)
AI_PROVIDER=anthropic        # or: openai | heuristic
AI_API_KEY=sk-ant-...
AI_MODEL=claude-sonnet-5

# Transcription → enables captions + transcript-aware highlights
TRANSCRIPTION_PROVIDER=openai   # or: deepgram | none
TRANSCRIPTION_API_KEY=sk-...
```

Restart the worker after changing these. If the LLM call fails, the worker logs a warning and falls back to heuristics — generation never hard-fails because of a provider.

## Admin panel

Make an account admin (first one via SQL):

```bash
docker exec clipforge-postgres psql -U clipforge -d clipforge \
  -c "UPDATE \"User\" SET role = 'ADMIN' WHERE email = 'you@example.com';"
```

Then the **Admin** entry appears in the sidebar:

- Platform stats (users, projects, clips, exports, processing, failures, credits spent)
- User table with search: change role/plan, adjust credits (±, ledgered), **suspend/reinstate** (suspension revokes sessions and blocks login)
- Failed renders with one-click free **retry**; failed projects with error messages
- `DELETE /admin/projects/:id` for content moderation (removes DB rows + queues storage cleanup)

All admin routes are guarded server-side (403 for non-admins); you cannot suspend or demote yourself.

## Configuration reference

All variables live in the root `.env` (see `.env.example` for the annotated list):

| Group | Variables |
| --- | --- |
| Database | `DATABASE_URL` |
| Redis | `REDIS_URL` |
| API | `API_PORT` (4000), `WEB_ORIGIN` (CORS + cookies), `NODE_ENV` |
| Auth | `JWT_SECRET`, `JWT_REFRESH_SECRET`, `JWT_ACCESS_TTL` (15m), `JWT_REFRESH_TTL` (7d) |
| Storage | `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT` (what the *browser* reaches), `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_FORCE_PATH_STYLE` |
| AI | `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL`, `TRANSCRIPTION_PROVIDER`, `TRANSCRIPTION_API_KEY` |
| Video tools | `FFMPEG_PATH`, `FFPROBE_PATH` (empty = use PATH) |
| Misc | `YTDLP_PATH` (optional, if `yt-dlp` isn't on PATH), `NEXT_PUBLIC_API_URL` |

## Testing

```bash
pnpm test                          # everything
pnpm --filter @clipforge/api test     # 17 Jest unit tests (auth, ownership, clips/credits)
pnpm --filter @clipforge/worker test  # 15 node:test units (heuristics, captions/ASS, filtergraphs)

# Full pipeline integration test against a RUNNING stack:
node scripts/e2e.mjs [optional-path-to-video.mp4]
#   registers a throwaway user → uploads → imports → generates highlights
#   → creates a clip → renders → downloads → verifies the MP4 with ffprobe
```

## Project structure

```
clipforge-ai/
├── apps/
│   ├── web/                  Next.js app (App Router, src/app + src/components)
│   ├── api/                  NestJS modules: auth, users, projects, highlights,
│   │                         clips, admin, storage, queues, usage, events, health
│   └── worker/               BullMQ processors + libs:
│       ├── processors/       video-import, highlight-generation, render-video, cleanup
│       └── lib/              ffmpeg, analysis, heuristics, llm, highlight-ai,
│                             transcribe, captions (ASS), render, storage, progress
├── packages/
│   ├── database/             Prisma schema, migrations, shared client
│   └── shared-types/         Queue contracts, timeline & editing-plan JSON, API types
├── docker/docker-compose.yml PostgreSQL + Redis + MinIO (+ bucket init)
├── docs/                     ARCHITECTURE.md · API.md · ROADMAP.md
└── scripts/e2e.mjs           Full-pipeline integration test
```

## API overview

Interactive documentation at **http://localhost:4000/docs**. Highlights:

```
POST /auth/register|login|refresh|logout      GET /auth/me
POST /uploads/presign
POST /projects            GET /projects            GET|PATCH|DELETE /projects/:id
POST /projects/:id/import                          GET /projects/:id/source
POST /projects/:id/highlights/generate             GET /projects/:id/highlights
POST /highlights/:id/create-clip
GET|PATCH|DELETE /clips/:id     POST /clips/:id/render
GET /clips/:id/render-status    GET /clips/:id/download    GET /projects/:id/exports
PATCH /users/me   POST /users/me/password   GET /users/me/credits
GET /admin/stats|users|jobs   PATCH /admin/users/:id
POST /admin/users/:id/credits   POST /admin/render-jobs/:id/retry
```

Auth is cookie-based (`credentials: include`); `Authorization: Bearer` also works. Realtime: Socket.IO namespace `/events` — emit `subscribe:project {projectId}`, listen for `project:progress`.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `pnpm install` times out on big packages | Slow connections starve parallel downloads. This repo already sets `networkConcurrency: 1` + long timeouts in `pnpm-workspace.yaml` — just re-run `pnpm install`; it resumes from cache. |
| MinIO image pull denied | MinIO left Docker Hub; the compose file already uses `quay.io/minio/*`. |
| Import stuck at "Extracting audio", ffmpeg at 100 % CPU | Some FFmpeg builds' native AAC encoder near-hangs at forced 16 kHz on certain content. Fixed: the worker extracts at the source sample rate. If you see it again, update FFmpeg. |
| Render fails mentioning `drawtext`/fontconfig | Your FFmpeg lacks font support for the watermark — the worker automatically retries without it. |
| Browser console hydration warning on `<body>` | A browser extension (e.g. Grammarly) injects attributes; harmless, suppressed in the root layout. |
| API up but worker "does nothing" | The worker is a separate process — make sure `pnpm dev:worker` is running and Redis is up (`docker ps`). |
| 402 errors | Out of credits — top up from the admin panel. |
| Prisma CLI can't find `DATABASE_URL` | Create `packages/database/.env` with the same `DATABASE_URL` as the root `.env`. |

## Roadmap

- **Next**: browser timeline editor (tracks, undo/redo, autosave of versioned timeline JSON), caption editing, more transitions & templates
- Then: face tracking / active-speaker crop, multi-person layouts, Remotion-based animated caption templates, batch generation
- Business: Stripe billing, plan enforcement, team workspaces, brand kits

See [docs/ROADMAP.md](docs/ROADMAP.md) for the detailed milestone plan.
