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

## Current status — Milestones 1–3 ✅ (core MVP flow works end-to-end)

**Upload → AI highlights → clip → render → download MP4** is fully working:

- Milestone 1: monorepo, Prisma schema, cookie JWT auth with refresh rotation, project CRUD with per-user ownership, presigned uploads, compliant YouTube metadata import, video-import worker, live progress, credits ledger, dashboard.
- Milestone 2: highlight generation — transcription providers (OpenAI Whisper / Deepgram, optional), FFmpeg signal analysis (audio energy, silences, scene cuts), LLM highlight selection (Claude/OpenAI, optional) with a **fully offline heuristic fallback** that needs no API keys.
- Milestone 3: clip creation from highlights with an editing plan, FFmpeg render pipeline (vertical/square/landscape, blurred background fill, slow zoom, fades, burned ASS captions, loudness normalization, FREE-plan watermark), quality check, exports with signed download URLs, re-render/edit/delete, credit charges + automatic refunds on failure.

Enable AI-quality results by setting keys in `.env` (all optional):
`AI_PROVIDER=anthropic` + `AI_API_KEY` for LLM highlight selection, and
`TRANSCRIPTION_PROVIDER=openai|deepgram` + `TRANSCRIPTION_API_KEY` for transcripts + captions.

Run the full pipeline test against a running stack: `node scripts/e2e.mjs`

Still ahead ([docs/ROADMAP.md](docs/ROADMAP.md)): the visual timeline editor, face tracking, templates, billing, admin.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full system design and
[docs/API.md](docs/API.md) for the endpoint reference.

## Rights & responsible use

Every import requires the user to declare a rights basis (owned / licensed / permission granted / Creative Commons / public domain) and confirm authorization. YouTube sources import **metadata only** through public, compliant endpoints; ClipForge does not download YouTube media. Attribution fields are stored with each source.
