# ADR-0003 — Vercel as the Phase 0 web runtime

Date: 2026-09-18

The web path is Next.js 16 (`next build --webpack`) on Vercel Node.js Functions, backed by Supabase. Functions target `icn1` (Seoul), matching Supabase `ap-northeast-2`. `main` is the intended production branch; non-main branches and PRs use Preview. Do not publish production until Phase 0 GO.

OpenNext, Wrangler, and the existing `crestix-ai-staging` Cloudflare Worker remain for rollback, but no release script or auth path uses Worker bindings. ADR-0001 and ADR-0002 are superseded for the web deployment path. Cloudflare may be reconsidered as a later Realtime Gateway; this decision does not begin Phase 1.

`TOKEN_ENCRYPTION_KEY` is read from Vercel's server-only runtime environment. Do not rotate it: existing `google_connections.encrypted_refresh_token` rows use the `v1` AES-256-GCM format. Google OAuth client credentials remain in Supabase Auth; the app does not use a service-role key. Vercel needs only `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `TOKEN_ENCRYPTION_KEY`. The legacy local `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` name is accepted temporarily for local compatibility, but should not be configured on Vercel.

OAuth uses the current request host after Origin, Host, X-Forwarded-Host, and X-Forwarded-Proto checks. Vercel domains and the Vercel-provided production domain are accepted; localhost is development-only. OAuth success and failure redirects use the same validated origin.

Lint, typecheck, unit tests, webpack build, audit, Preview deployment, Supabase redirect allowlist, authenticated OAuth, token decrypt, RLS, and browser role matrix must all pass before Phase 0 GO.
