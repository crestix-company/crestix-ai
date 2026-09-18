# Google OAuth setup

Phase 0 uses Google through Supabase Auth with `openid email profile` and Calendar events read-only. It requests offline consent and encrypts the provider refresh token server-side. Calendar event synchronization begins in Phase 1, not Phase 0.

Manual setup:

1. Create or select the CRESTIX Google Cloud project.
2. Configure the OAuth audience as Internal when the application is exclusively for the CRESTIX Workspace.
3. Create a Web application OAuth client.
4. Set the Google Cloud OAuth Authorized Redirect URI to `https://ogdyrqvjvmqghawxfpav.supabase.co/auth/v1/callback`. This is the **Supabase provider callback**, not the app callback.
5. For local Supabase, add `http://127.0.0.1:54321/auth/v1/callback`.
6. Configure Google in Supabase Auth.
7. In the remote Supabase project's **Auth → URL Configuration → Redirect URLs**, add the exact app callbacks:
   - `http://localhost:3000/auth/callback`
   - the exact Vercel Preview URL followed by `/auth/callback`, once assigned.
   - the eventual production origin followed by `/auth/callback` before production launch.
   A narrowly scoped Vercel Preview wildcard can cover dynamic preview domains; prefer exact URLs when possible. The remote `Site URL` should be the eventual canonical production URL; it is not a replacement for these redirect allowlist entries.

The Vercel login action and callback derive the current HTTPS origin from validated `Host`, `Origin` (login POST), `X-Forwarded-Host`, and `X-Forwarded-Proto` headers. Vercel deployment domains and the Vercel-provided production host are accepted; localhost is development-only. Both OAuth start and callback redirects use the same origin, so the PKCE verifier cookie returns to that host. Cloudflare's `APP_ORIGIN` binding is no longer part of the web runtime. Restart OAuth from `/login` after changing the deployment origin; an old authorization code cannot be reused.

The SSR cookie is host-only, uses `SameSite=Lax`, and is `Secure` on staging/production HTTPS. Local HTTP development uses the same cookie policy without `Secure`.

`TOKEN_ENCRYPTION_KEY` is a Base64 or Base64URL encoding of exactly 32 random bytes for AES-256-GCM. The key is decoded only in the server runtime. Google `provider_refresh_token` is opaque UTF-8 text, never decoded as Base64. Encrypted rows remain in the existing `v1.<standard-base64 IV>.<standard-base64 ciphertext+GCM tag>` format; the reader accepts that format and does not require a data migration. Do not rotate the existing key while those rows exist. During Phase 0 diagnosis, logs may contain only key format metadata (length, character-set flags, decoded byte count), never key or token contents.

For this Phase 0 smoke test, OAuth start logs only the selected app `redirect_to`, and the callback logs only the resolved redirect origin and boolean host/proto matches. Remove these temporary diagnostics after verification. On exchange failure, the callback also logs only a trace ID, a sanitized error code/category, resolved origin/path, environment, and whether the PKCE verifier cookie was present. It never logs the authorization code, cookie value, session token, provider token, or refresh token. Use the trace ID on the login error URL to correlate safe server logs.

Do not paste client secrets into documentation, source files, seed data, or browser-visible environment variables.
