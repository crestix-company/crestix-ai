# E1 manual ChatGPT preparation flow

Date: 2026-09-19
Status: **GO — verified end-to-end on Production**

## What this is

The first usable slice of FS meeting preparation. It does not require any AI
provider API key. An FS rep opens a detected E1 meeting, copies a generated
research prompt, runs it in their own ChatGPT, and pastes the answer back.
Crestix AI validates and stores it as structured `meeting_preparations` data.

```text
/fs/meetings/[id] (E1 only)
  -> copy prompt (meeting info + full Master Skill + JSON schema)
  -> FS rep runs it in their own ChatGPT
  -> paste the answer back
  -> extract JSON (fenced or bare) -> Zod validate
  -> meeting_preparations upsert (source_mode = MANUAL_CHATGPT)
  -> meetings.status = READY
  -> full results view (summary / facts-hypotheses-needs_confirmation / clinic info / full talk script / sources)
```

Non-E1 meetings show an explicit "not supported yet" message instead of a
broken flow. Re-pasting overwrites the existing preparation and increments
`attempt_count`.

## Why manual ChatGPT and not an API call

`OPENAI_API_KEY` (or any AI provider key) does not exist yet, and
`/fs/meetings/[id]` must not depend on one. The `AiProvider` interface stays
for a future API-based mode (`source_mode = 'API'`), but nothing in this flow
calls it.

## Database

Two migrations already applied directly to the remote database before this
change (`phase2_preparation_mvp`, `phase2_preparation_hardening`) were missing
their local files; added them for parity without re-running them. One new
forward-only migration adds `meeting_preparations.source_mode` (`MANUAL_CHATGPT`
default, or `API`).

`skills` / `skill_versions` / `agent_runs` already had an explicit
authenticated-deny RLS policy from the hardening migration — only the admin
(service-role) client can read/write them. `meeting_preparations` grants
`select` to authenticated users, scoped through the existing `meetings`
visibility RLS (FS_MEMBER own meetings, FS_MANAGER / ADMIN same-org FS); all
writes go through the admin client after an explicit RLS-gated visibility +
E1 check in the server action, mirroring the pattern already used for
Calendar sync.

## Skill handling

`lib/skills/loader.ts` reads `skills/fs/medical-fs-e1-complete/SKILL.md` fresh
from disk on every prompt build and prepare-save, hashes it (SHA-256), and
records an immutable `skill_versions` row keyed by that hash (idempotent — a
repeat load with unchanged content just re-affirms the same version row). The
Skill's content is never copied into another source file; it is only read at
request time and interpolated into the generated prompt text, consistent with
`skills.md`.

## A real deployment bug found and fixed during this pass

`lib/skills/loader.ts` reads the Skill file via a **dynamic**
`fs.readFile(path.join(process.cwd(), ...))` call. Next.js's build-time output
file tracer only follows static `import`/`require`/`fs` usage it can analyze —
a runtime-computed path isn't one of those, so `skills/` was silently dropped
from the deployed Vercel serverless function bundle even though local `next
build` and `next dev` both work fine (full filesystem access outside the
traced bundle). This surfaced immediately in the first live end-to-end test as
`ENOENT: .../var/task/skills/fs/medical-fs-e1-complete/SKILL.md`. Fixed by
adding `outputFileTracingIncludes: { "/*": ["skills/**/*"] }` (plus an escaped
key for the `[id]` dynamic route) to `next.config.ts`. Verified locally before
redeploying by grepping the emitted `.next/server/app/fs/meetings/[id]/page.js.nft.json`
trace file (zero `skills/` references before, exactly one after).

## End-to-end acceptance (Production)

Verified against a synthetic E1 meeting inserted directly into the remote DB
(cleaned up afterward; the real HD meetings from Phase 1's Calendar sync were
left untouched throughout):

- Non-E1 meeting detail page shows the "E1のみ対応" message instead of the
  preparation UI.
- E1 meeting detail page renders the copy-prompt button and paste form with no
  errors.
- Pasting a fenced ```json block with a full valid payload and saving:
  redirects to `?status=prep_saved`, sets `meeting_preparations.status =
  READY`, `source_mode = MANUAL_CHATGPT`, `attempt_count = 1`, and
  `meetings.status = READY`. The results view renders the proposal/why/key-
  points/objections/recommended-responses/must-ask/withdrawal-conditions
  summary, the facts/hypotheses/needs_confirmation section (with a clickable
  `[source]` link), clinic info, the full talk script text, and clickable
  Sources.
- Pasting plain non-JSON text and saving again: redirects to
  `?status=prep_invalid_json` with the "ChatGPTの回答形式を確認してください"
  message, and does **not** touch the database (`attempt_count` stayed at 1,
  prior data unchanged).

## Unresolved / out of scope for this pass

- `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` / `CRON_SECRET`
  Production env vars still need a final confirmation pass (see the Phase 1
  watch-renewal investigation) — this does not block the preparation flow,
  which never calls Google APIs.
- No production E1 meeting exists yet from real Calendar data (only HD so
  far), so a real FS rep has not yet run the flow against a live medical
  practice event. The end-to-end path itself is fully verified with synthetic
  data.
- API-based auto-generation (`source_mode = 'API'`), Live Copilot, voice
  input, E2/CS/IS/Company AI, and company-wide KPIs are explicitly out of
  scope for this pass.
