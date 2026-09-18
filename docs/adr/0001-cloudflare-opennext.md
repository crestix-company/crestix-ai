# ADR-0001: Use OpenNext for Phase 0

Status: Accepted for Phase 0  
Date: 2026-09-16

## Context

The MVP specification names Next.js with the OpenNext Cloudflare adapter as the primary deployment architecture. Cloudflare currently recommends vinext for new Next.js applications and documents OpenNext mainly for existing OpenNext applications.

## Decision

Use OpenNext in Phase 0 because the user explicitly made the supplied specification the highest-level requirement. Configure `nodejs_compat`, a current compatibility date, and explicit preview/deploy scripts.

Pin OpenNext 1.19.11 and use the legacy Edge Middleware entry point for Supabase session refresh. OpenNext 1.20.6 supports the Next.js 16 Node Proxy experimentally, but its required `rclone.js` dependency currently carries an unfixed high-severity `adm-zip` advisory. This project does not accept that dependency while a vulnerability-free compatible path exists.

## Consequences

- The application matches the approved specification.
- OpenNext compatibility must be verified in every release build.
- Next.js may warn that `middleware.ts` is deprecated in favor of Node Proxy. Do not migrate until the chosen OpenNext release supports Node Proxy without introducing known high-severity dependencies.
- Before production, rerun a documented vinext compatibility assessment. Migration requires an explicit architecture decision and must not be performed incidentally.
