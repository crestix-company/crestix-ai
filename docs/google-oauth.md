# Google OAuth setup

Google login is handled by Supabase Auth. The application requests:

- `openid`
- `email`
- `profile`
- `https://www.googleapis.com/auth/calendar.events.readonly`

OAuth uses `access_type=offline` and `prompt=consent`. The provider refresh token is encrypted server-side with AES-256-GCM and stored in `google_connections`. It is never stored in browser storage or logged.

## Redirects

Google Cloud Authorized Redirect URI:

```text
https://ogdyrqvjvmqghawxfpav.supabase.co/auth/v1/callback
```

Supabase Auth production callback allowlist:

```text
https://crestix-ai.vercel.app/auth/callback
```

Local development may also allow:

```text
http://localhost:3000/auth/callback
```

The Vercel login action and callback derive the current HTTPS origin from validated request headers so PKCE stays on the same host.

## Phase 1 background Calendar access

Supabase Auth returns `provider_token` / `provider_refresh_token`, but it does not manage Google provider access-token refresh for background API calls. Phase 1 therefore needs the same Google Web OAuth client credentials server-side:

```text
GOOGLE_OAUTH_CLIENT_ID
GOOGLE_OAUTH_CLIENT_SECRET
```

These values are secrets on Vercel and must never use a `NEXT_PUBLIC_` prefix.

The background flow is:

```text
encrypted provider refresh token
  -> decrypt on trusted server
  -> Google OAuth token endpoint
  -> short-lived access token
  -> Google Calendar API
```

Do not rotate `TOKEN_ENCRYPTION_KEY` while existing encrypted rows remain.

## Platform-log residual risk

The app does not log the OAuth authorization code, tokens, cookies, or secret values. Vercel-managed request metadata may still display the short-lived PKCE authorization `code` query parameter on `/auth/callback`. Phase 0 accepts this as a documented residual platform risk; application logs must not duplicate it.
