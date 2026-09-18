# ADR-0002: Phase 0 Cloudflare build uses webpack Next.js and OpenNext

Status: Accepted for Phase 0  
Date: 2026-09-17

## Context

The default Next.js 16 Turbopack build failed in the sandbox while binding a local child-process port (`EPERM`). This is a host restriction, not evidence of an application compile error. The webpack Next.js build and OpenNext bundle both complete successfully.

## Decision

Use `next build --webpack` followed by `opennextjs-cloudflare build --skipNextBuild` as the Phase 0 Cloudflare deployment build. Set `output: "standalone"` because OpenNext's skip-build mode consumes `.next/standalone`.

Worker secrets are runtime bindings. The build must run without server-only secret values in `.env.local` or process environment. Local development may still use `.env.local`; release builds must use an isolated environment containing only public build variables. `wrangler deploy --dry-run --outdir ...` is used to inspect the upload payload.

## Consequences

- Turbopack's sandbox port error is not a Phase 0 blocker.
- A release is blocked if the actual key or canary occurs in browser assets, final Worker, or the Wrangler dry-run upload payload.
- A successful local build is not equivalent to a deployed Worker runtime smoke test.
