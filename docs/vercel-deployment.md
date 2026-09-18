# Vercel Phase 0 deployment

Use the Next.js framework preset, Node.js Functions, `npm run build` (`next build --webpack`), and `vercel.json` region `icn1`. Production branch: `main`; other branches/PRs: Preview. Do not deploy production until Phase 0 GO. The Cloudflare Worker is retained, not deleted.

Set these environment variable **names** in Preview and Production:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` (Supabase publishable/anon browser key; never service-role)
- `TOKEN_ENCRYPTION_KEY` (server-only; use the **existing** key unchanged)

Google Client Secret remains in Supabase Auth. Do not add `SUPABASE_SERVICE_ROLE_KEY`. Never commit `.env.local` or put a secret in a CLI argument. For Preview, verify `vercel env ls preview` lists names only. If the existing key for encrypted rows cannot be identified, stop rather than substituting a new one.

Register the exact Preview `/auth/callback` URL in Supabase Auth Redirect URLs before testing. For dynamic Preview domains, use a narrowly scoped Vercel wildcard supported by Supabase; set the production callback to an exact URL. Local development may retain `http://localhost:3000/auth/callback`. Google Cloud's authorized redirect URI remains `https://ogdyrqvjvmqghawxfpav.supabase.co/auth/v1/callback`.

Run `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm audit --audit-level=high`, then deploy Preview with `vercel deploy`. Verify Google OAuth → Supabase → same-origin Vercel `/auth/callback` → `/fs/meetings`, `/admin`, token encryption/decryption, and the browser authorization matrix. Never paste an OAuth code, cookie, or token into a report.
