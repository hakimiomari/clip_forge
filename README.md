# ClipForge AI

AI-powered video highlight generator & short-form video editor. Users import video content they **own, have permission to use, or are legally authorized to process**; ClipForge analyzes it, finds the best moments, and produces polished vertical/square/landscape clips with captions and effects.

> ClipForge is not a copyright-bypass tool. Editing effects (cropping, zooming, mirroring, transitions) do not make copyrighted material safe to republish and do not guarantee Content ID avoidance.

## Monorepo layout

```
clipforge-ai/
├── apps/
│   ├── web/        Next.js 15 app — dashboard, import wizard, editor (upcoming)
│   ├── api/        NestJS API — auth, projects, uploads, queues, realtime events
│   └── worker/     BullMQ worker — FFmpeg probing, thumbnails, audio extraction
├── packages/
│   ├── database/   Prisma schema + shared client (@clipforge/database)
│   └── shared-types/  Queue contracts, timeline & editing-plan JSON types
├── docker/         Local infrastructure (PostgreSQL, Redis, MinIO)
└── docs/           Architecture, API and roadmap documentation
```

## Prerequisites

- Node.js ≥ 22 and **pnpm** (`corepack enable` or `npm i -g pnpm`)
- **Docker** (for PostgreSQL, Redis and MinIO)
- **FFmpeg** and **FFprobe** on your `PATH` (or set `FFMPEG_PATH` / `FFPROBE_PATH`)

## Quick start

```bash
# 1. Install dependencies
pnpm install

# 2. Configure environment
cp .env.example .env
#    → set JWT_SECRET and JWT_REFRESH_SECRET to long random values:
#    node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# 3. Start infrastructure (PostgreSQL, Redis, MinIO + bucket bootstrap)
pnpm infra:up

# 4. Create the database schema
pnpm db:generate
pnpm db:migrate        # prisma migrate dev — creates the initial migration

# 5. Run everything (API :4000, web :3000, worker)
pnpm dev
```

Open http://localhost:3000, register an account, create a project and upload a video. The worker probes it with FFprobe, generates a thumbnail, extracts the audio track and marks the project **Imported** — progress streams live over Socket.IO.

- API docs (Swagger): http://localhost:4000/docs
- MinIO console: http://localhost:9001 (user `clipforge`, password `clipforge-secret`)
- Prisma Studio: `pnpm db:studio`

## Useful scripts

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Run api + web + worker together |
| `pnpm dev:api` / `dev:web` / `dev:worker` | Run one app |
| `pnpm build` | Build every package/app |
| `pnpm test` | Run tests (API unit tests today) |
| `pnpm db:migrate` | Create/apply dev migrations |
| `pnpm infra:up` / `infra:down` | Start/stop Docker infrastructure |

## Current status — Milestone 1 ✅

Implemented: monorepo, Prisma schema (all core entities), cookie-based JWT auth with refresh rotation, project CRUD with strict per-user ownership, presigned direct-to-storage uploads, compliant YouTube metadata import (oEmbed; no media download), video-import worker (FFprobe metadata, thumbnail, audio extraction), live progress over WebSockets, credits ledger, dashboard.

Next milestones are described in [docs/ROADMAP.md](docs/ROADMAP.md):
- **Milestone 2** — transcription pipeline, AI highlight detection, highlight UI
- **Milestone 3** — clip generation, vertical conversion, captions, effects, rendering, MP4 download

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full system design and
[docs/API.md](docs/API.md) for the endpoint reference.

## Rights & responsible use

Every import requires the user to declare a rights basis (owned / licensed / permission granted / Creative Commons / public domain) and confirm authorization. YouTube sources import **metadata only** through public, compliant endpoints; ClipForge does not download YouTube media. Attribution fields are stored with each source.
