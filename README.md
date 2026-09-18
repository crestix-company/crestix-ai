# CRESTIX AI OS / FS Sales AI

Internal TEST MVP for FS sales preparation and, in a later phase, real-time meeting assistance.

## Phase status

- Phase 0: Vercel migration in progress; Preview OAuth and browser authorization smoke tests remain
- Phase 1–5: not implemented

See `docs/gap-analysis.md`, `docs/open-questions.md`, and `docs/adr/0003-vercel-phase-0.md` before changing architecture or sales behavior.

## Requirements

- Node.js 24
- npm
- Docker-compatible runtime for local Supabase
- Supabase CLI

## Setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

Use only a publishable Supabase key in `NEXT_PUBLIC_SUPABASE_ANON_KEY`. Never expose a service-role or secret key to the browser. See `docs/vercel-deployment.md`.

## Verification

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run preview
```

## Bootstrap

Signup is disabled. Create the initial Auth user, profile, organization, and ADMIN membership through an audited environment-specific operation. Do not add real people or credentials to `supabase/seed.sql`.

## Scope

The product is not a Calendar UI, KPI tracker, or company-wide task manager. Calendar integration begins in Phase 1. `skills/fs/medical-fs-e1-complete/SKILL.md` is the only source of truth for FS E1 sales logic and must not be silently changed, summarized, or copied into competing Skills.
