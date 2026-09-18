# CRESTIX AI OS / FS Sales AI

Internal TEST MVP for FS sales preparation and real-time meeting assistance.

## Phase status

- Phase 0: GO with accepted residual risk for short-lived PKCE authorization code visibility in Vercel-managed request metadata
- Phase 1: source implementation prepared; remote Supabase schema applied; Vercel deployment and production Calendar acceptance smoke pending
- Phase 2–5: not complete

See `docs/phase-1-report.md`, `docs/calendar-detection.md`, `docs/gap-analysis.md`, and `docs/adr/0003-vercel-phase-0.md`.

## Requirements

- Node.js 22
- npm
- Docker-compatible runtime for local Supabase
- Supabase CLI

## Setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

Only the Supabase URL and publishable key may be exposed with `NEXT_PUBLIC_`.
Calendar refresh credentials, Supabase server key, cron secret, and token encryption key are server-only.

## Verification

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

For local database policy tests:

```bash
supabase test db
```

## Bootstrap

Signup is disabled. Create the initial Auth user, profile, organization, and ADMIN membership through an audited environment-specific operation. Do not add real people or credentials to `supabase/seed.sql`.

## Scope

The product is not a Calendar UI, KPI tracker, or company-wide task manager. Calendar is an input source for FS meetings. `skills/fs/medical-fs-e1-complete/SKILL.md` remains the only source of truth for FS E1 sales logic and must not be silently changed, summarized, or copied into competing Skills.
