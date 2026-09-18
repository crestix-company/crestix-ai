# GAP ANALYSIS

Date: 2026-09-16  
Requirements baseline: `CRESTIX_FS_SALES_AI_TEST_MVP_SPEC_v1.2.md`

## Repository baseline

The repository began empty. It now contains the uncommitted Phase 0 implementation described below. No credential history exists because the repository still has zero commits.

## Specification gap

| Area | Initial state | Required state | Phase |
|---|---|---|---|
| Next.js | Missing | App Router, TypeScript, Tailwind, shadcn/ui | 0 |
| Cloudflare | Missing | Workers + OpenNext, Wrangler preview/deploy | 0 |
| Supabase | Missing | Local config, schema, Auth, RLS | 0 |
| Authorization | Missing | Active organization membership and role enforcement | 0 |
| Google Calendar | Missing | OAuth scope, watch, webhook, incremental sync | 1 |
| Skill source | Supplied and byte-identical | Registry and single E1 master Skill | 0 |
| Skill runtime | Missing | Loader, parser, SHA-256 versioning, three runtime modes | 2/4 |
| AI preparation | Missing | Provider adapter, research, structured output, jobs | 2 |
| FS UI | Missing | Meeting list/detail and status workflow | 3 |
| Live assistance | Missing | STT, WebSocket, Talk Skill, live state | 4 |
| Hardening | Missing | Security/E2E tests, monitoring, recovery | 5 |

## Inputs that must not be invented

- CRESTIX Workspace domain
- initial ADMIN and FS membership list
- masked Calendar event samples and definitive meeting naming rules
- preparation Skill and talk Skill contents
- Cloudflare, Supabase, and Google project identifiers
- AI/STT provider choices
- transcript retention approval

## Current implementation status

Phase 0 source implementation includes the secret-free foundation, pinned lockfile, configuration contracts, core membership schema, RLS, Google login flow, protected shell, tests, documentation, and Cloudflare/OpenNext runtime verification. The app fails closed when configuration or membership is absent.

Pending Phase 0 acceptance checks require a Docker-compatible local Supabase runtime plus approved Workspace/initial ADMIN configuration. Google provider refresh token storage, Calendar scope, event synchronization, meeting schema, preparation jobs, and live transcription remain in their designated later phases.

## v1.2 Skill integrity

- `skills.md` matches the supplied Registry byte-for-byte.
- `skills/fs/medical-fs-e1-complete/SKILL.md` matches the supplied master Skill byte-for-byte.
- SHA-256 is recorded in the Phase 0 report.
- No full sales logic is copied into application source.

## Current technical decision

The source specification is the highest-level requirement and explicitly chooses OpenNext. Cloudflare's current documentation recommends vinext for new applications, so this repository records OpenNext as a specification-driven exception in ADR-0001 rather than silently changing the architecture.
