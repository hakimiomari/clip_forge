# ClipForge AI — Implementation roadmap

## Milestone 1 — Foundation ✅ (this commit)

- pnpm monorepo, Docker infra (PostgreSQL, Redis, MinIO), root `.env`
- Prisma schema for all core entities (users, projects, sources, transcripts,
  highlights, clips, timelines, captions, templates, render jobs, exports,
  credits, subscriptions, refresh tokens)
- NestJS API: cookie JWT auth + refresh rotation, project CRUD with ownership,
  presigned uploads, import endpoint, credits ledger, dashboard stats,
  Socket.IO progress gateway, Swagger, rate limiting, unit tests
- Worker: `video-import` (FFprobe metadata, thumbnail, 16 kHz audio extract,
  YouTube oEmbed metadata), `cleanup-files`; Redis progress publishing
- Next.js web: auth pages, app shell, dashboard, project list/detail,
  import wizard with direct-to-storage upload + rights confirmation,
  live progress

## Milestone 2 — Understanding & highlights

1. **Transcription queue**: provider abstraction (`TRANSCRIPTION_PROVIDER`) —
   Whisper-API/Deepgram adapters; store `Transcript` + `TranscriptSegment`
   with timestamps; surface transcript in the project page.
2. **Scene analysis**: FFmpeg scene-change scores + audio loudness curve
   stored per project (JSON) for the highlight scorer.
3. **Highlight generation**: LLM agent (configurable `AI_PROVIDER`) that takes
   the transcript + analysis, applies the weighted rubric (hook 25 %,
   standalone 20 %, info value 20 %, emotion 15 %, visual 10 %, audio 5 %,
   ending 5 % — configurable), and must not cut mid-sentence. Emits scored
   candidates with title/hook/reason/category.
4. **Highlight UI**: candidate cards with score, hook, reason; select a
   candidate and duration options (30/45/60/90/120 s, count, format,
   editing + caption style) → creates a `Clip` draft.
5. Credits: charge `generateHighlights`; project statuses `ANALYZING` /
   `GENERATING_HIGHLIGHTS` / `READY` wired to progress events.

## Milestone 3 — Clips, rendering & download

1. **Editing Plan Agent** → `EditingPlan` JSON (segments, crop, zooms,
   transitions, caption config, audio) → materialized `Timeline`.
2. **Caption generation** from transcript segments (word/karaoke modes).
3. **Render pipeline**: FFmpeg filtergraph renderer (trim, scale/crop 9:16,
   blurred background pad, subtitle burn-in via ASS, fades, loudnorm);
   Remotion composition for animated caption templates; `RenderJob`
   progress → quality check (duration, black frames, audio present) →
   upload MP4 → `Export` row.
4. **Export/download API + UI**: render status, "Your video is ready" modal,
   signed download URLs, export history, re-render, delete.
5. Watermark for FREE plan; credit charges by rendered duration.

## Milestone 4 — Editor & growth (V2/V3 of the PRD)

- Browser timeline editor (tracks UI, undo/redo, autosave of versioned
  timeline JSON), caption/text/effect tools, template gallery
- Face tracking & active-speaker crop (architecture hook exists in
  `CropConfig.mode = "face_tracking"`), multi-person layouts
- Billing (Stripe), plan enforcement, admin dashboard, team workspaces
