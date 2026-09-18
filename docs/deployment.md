# Deployment

> Historical Cloudflare rollback path only. The Phase 0 web deployment path is now `docs/vercel-deployment.md` (ADR-0003).

## Local

1. Install the pinned dependencies with `npm install` and commit the generated lockfile.
2. Copy `.env.example` to `.env.local` and replace only local values.
3. Start Supabase with `npx supabase start` after reviewing CLI help.
4. Run `npm run dev` for normal Next.js development.
5. Run `npm run preview` to verify the Workers runtime.

## Cloudflare

The Phase 0 Worker needs `TOKEN_ENCRYPTION_KEY` only. `wrangler.jsonc` declares the required name in both environments; no secret value belongs in `vars`. Google client credentials stay in Supabase Auth. No service-role key is used by the Phase 0 Worker. **Do not rotate the existing encryption key** while validating existing encrypted tokens.

`wrangler secret put` immediately deploys a new Worker version. Use it on staging only when that deployment is intended; for production, which must stay unchanged in Phase 0, use the interactive `wrangler versions secret put TOKEN_ENCRYPTION_KEY` workflow only after reviewing the current Worker/version state. Never pass a secret value in a CLI argument or shell history. Confirm names with `wrangler secret list`, not values.

For release builds, use an isolated environment without `.env.local` or server-only process variables. Supply only `NEXT_PUBLIC_*` build values; run `npm run build`, `npx opennextjs-cloudflare build --skipNextBuild`, then `npx wrangler deploy --dry-run --outdir <validated temporary directory>` and scan that payload before deploying staging. The `npm run preview`/`npm run deploy` convenience scripts are not a substitute for this isolation check. Verify `npx wrangler secret list --env staging` lists the required name, and perform an authenticated TEST Worker smoke test before production.

The initial Phase 0 staging deployment was performed outside this task and exposed the OAuth redirect bug. The corrected build must be verified before a staging-only redeploy.

## Staging OAuth smoke test

Before redeploying staging, confirm the remote Supabase Redirect URLs include the exact staging and local `/auth/callback` URLs in `docs/google-oauth.md`. Google Cloud's Authorized Redirect URI remains the Supabase `/auth/v1/callback`, not the app route. Staging's non-secret runtime `APP_ORIGIN` binding fixes the canonical app origin; production must set its own HTTPS `APP_ORIGIN` before launch. Neither environment uses `NEXT_PUBLIC_APP_URL` or a localhost fallback. In development only, CSP permits `'unsafe-eval'` for Next.js React Refresh; staging and production do not.

After the isolated webpack/OpenNext build and secret scan, deploy **staging only** with `npx wrangler deploy --env staging`. Do not run the default-environment deploy. Confirm the response stays on the staging origin throughout Google → Supabase → app callback, then verify `/fs/meetings` and `/admin`. Production remains unchanged until Phase 0 GO.
