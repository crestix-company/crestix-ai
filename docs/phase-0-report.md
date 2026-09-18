# Phase 0 report

> Historical Cloudflare staging report. The web runtime changed to Vercel on 2026-09-18; see ADR-0003 and `docs/vercel-deployment.md`. The results below do not establish Vercel Phase 0 GO.

Date: 2026-09-18  
Status: **NO-GO — staging OAuth redirect bug fixed in source, but redeploy and browser smoke test are pending**

## Staging OAuth / CSP bugfix (2026-09-18)

The deployed staging login action was reproduced returning `redirect_to=http://localhost:3000/auth/callback`, which sent the code to a different origin than the staging PKCE verifier cookie. The source now derives the app callback from a validated same-origin `Origin`/`Host` pair rather than `NEXT_PUBLIC_APP_URL`. Supabase SSR cookies gain `Secure` in staging/production while retaining `SameSite=Lax`; development alone gets CSP `'unsafe-eval'` for React Refresh. Callback exchange errors log a safe trace/category without authorization code, cookie, or token values.

Follow-up: after the first staging deployment, live OAuth start returned the correct staging `redirect_to`, but callback success/error branches still constructed absolute redirects from `request.url`. OpenNext may supply its internal localhost URL there. Staging now uses a non-secret runtime `APP_ORIGIN` binding for both OAuth start and every callback redirect; localhost config outside development fails closed. Staging deployment `418600b4-469c-4fb5-9494-266ae8633128` passed anonymous redirect smoke tests and clean-build scans. Authenticated Google browser smoke remains pending, so Phase 0 is still NO-GO.

The corrected build passed lint, typecheck, 12 unit tests, webpack, OpenNext, and `npm audit` (0 vulnerabilities). The isolated `.next`, `.open-next`, and staging Wrangler dry-run upload contain zero hits for the actual local encryption key, old localhost callback, and deprecated app URL variable. The production routes manifest excludes `'unsafe-eval'`; localhost's live CSP header includes it. The remote Supabase redirect allowlist is not yet verified. The corrected Worker has not been deployed because Wrangler remains unauthenticated in this Codex execution environment. Staging OAuth browser smoke, refresh-token decrypt, and protected-route checks remain pending; Phase 1 has not started.

## Implemented

- Next.js App Router/TypeScript/Tailwind foundation
- Google login via Supabase Auth PKCE callback
- Google OAuth scopes: `openid`, `email`, `profile`, and Calendar events read-only
- offline consent request using `access_type=offline` and `prompt=consent`
- server-only AES-256-GCM encryption of `provider_refresh_token`
- encrypted token persistence in `google_connections`; no browser storage or frontend DB write
- fail-closed authorization based on active organization membership
- Phase 0 PostgreSQL schema, grants, RLS, and rollback-only SQL tests
- Cloudflare Workers/OpenNext configuration and secret contract
- CI, security headers, tests, and project documentation
- byte-identical v1.2 Skill Registry and master FS E1 Skill

## Supabase execution

Linked project: `ogdyrqvjvmqghawxfpav`

Applied migrations (local and remote are identical):

1. `20260916000000_phase0_foundation.sql`
2. `20260916061455_add_google_connections.sql`

No destructive migration was applied. The linked project had no public application tables before the first migration.

Remote public tables:

- `profiles`
- `organizations`
- `organization_memberships`
- `google_connections`

Seed state:

- `CRESTIX` organization: created (one row)
- initial Auth user: `hiroyuki.maekawa@crestix-inc.com` created by Google OAuth
- initial ADMIN membership: `FIRST_DIVISION / FS / ADMIN / active` created

## RLS policies

- `profiles`: self select, insert, and update
- `organizations`: active-member select
- `organization_memberships`: member select; admin insert, update, and delete
- `google_connections`: self select, insert, and update

RLS is enabled on every application table. Anonymous table privileges are revoked, and authenticated privileges remain constrained by RLS.

## Verification results

Passed:

- repository and Skill inventory
- migration dry-runs and remote application
- local/remote migration parity (no migration drift)
- remote table inventory
- rollback-only remote RLS SQL test suite
- rollback-only remote inactive/no-membership/cross-organization/FS_MEMBER role-denial matrix; fixtures absent afterward
- CRESTIX organization initialization
- real Google OAuth consent and callback
- Google consent UI confirmed Calendar event display/read-only; no write/delete grant
- `provider_refresh_token` receipt confirmed by encrypted `google_connections` row
- encrypted envelope validated without displaying token material
- initial ADMIN membership creation
- real ADMIN `/fs/meetings` and `/admin` browser access
- OAuth request parameter source tests
- AES-256-GCM encryption/decryption and wrong-user rejection tests
- credential-file check and high-signal secret scan
- dependency audit (0 vulnerabilities)
- ESLint
- TypeScript typecheck
- Vitest (2 files, 4 tests)
- Next.js production build
- OpenNext Cloudflare build
- Wrangler local smoke test

Pending:

- separate authenticated browser-session E2E for inactive/no-membership/cross-organization/FS_MEMBER denial
- Cloudflare Wrangler authentication, staging/production Secret presence, and TEST Worker runtime smoke test
- browser-control recovery before temporary membership mutation and denial E2E

The first successful OAuth callback redirected to `not_authorized` because the new Auth user had no membership. That was the expected fail-closed result. After adding the explicitly requested initial ADMIN membership, the same session reached both protected FS and ADMIN routes.

## Security review

- No Google client ID, Google client secret, service-role key, or token is committed.
- Local runtime values are in ignored `.env.local` only.
- Only the Supabase URL and publishable key are intended for the client bundle.
- The refresh token is handled only in the server callback and encrypted before database persistence.
- AES-GCM additional authenticated data binds ciphertext to the Supabase user UUID.
- Token values are not logged by application code.
- An earlier build from `.env.local` contaminated the ignored OpenNext intermediate `.open-next/cloudflare/next-env.mjs`. Existing build artifacts were deleted. The new isolated clean build with a test-only canary key yielded zero key hits in `.next` and `.open-next`; Wrangler default/staging dry-run upload payloads yielded zero actual-key hits. Runtime key access is centralized through the Cloudflare binding. Release builds must exclude server-only `.env.local` values.

The latest rerun passed ESLint, TypeScript, 4 unit tests, webpack-mode Next.js production build, OpenNext bundle generation from its standalone output, and `npm audit` (0 vulnerabilities). ADR-0002 records the default Turbopack sandbox port-bind failure as a host limitation, not a Phase 0 blocker. `npx wrangler whoami` is currently unauthenticated. No Worker Secret was set or deployment performed.

## Phase boundary issue

The cross-user `meeting UUID` RLS test is assigned to Phase 1 because `meetings` is created there, not in Phase 0.

## GO decision

Phase 0 remains **NO-GO** until browser denial E2E, Wrangler authentication and Secret validation, and TEST Worker runtime smoke checks pass. Phase 1 has not started.

## Skill integrity

- Registry SHA-256: `27551ac237d3b850b4869e0fd438387896936ec7934a60cccb0b2f57a492059b`
- Master Skill SHA-256: `b8d7944934ef4312db6510475cf7a7837fa01c52a1def634615f5d6e3d1a9a05`
- Both repository files are byte-identical to the supplied attachments.
