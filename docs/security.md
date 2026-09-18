# Security

## Authorization source of truth

`organization_memberships` is the authorization source of truth. Email domain matching and user-editable `user_metadata` are not authorization controls.

Phase 0 requires an authenticated user to have an active `FIRST_DIVISION` / `FS` membership. Server Components check membership and PostgreSQL RLS enforces the same organization boundary.

## RLS matrix

| Resource | FS_MEMBER | FS_MANAGER | ADMIN |
|---|---|---|---|
| Own profile | Read | Read | Read |
| Same-organization profiles | Read | Read | Read |
| Organization | Own organization | Own organization | Own organization |
| Memberships | Same organization, read | Same organization, read | Same organization, CRUD |
| Other organization | Deny | Deny | Deny |

The private RLS helper functions use `SECURITY DEFINER` only to avoid recursive membership-policy evaluation. They live in the unexposed `app_private` schema, set an empty `search_path`, reject missing `auth.uid()`, revoke `PUBLIC`, and grant execute only to `authenticated`.

## Secrets

- Frontend receives only the Supabase URL and publishable key.
- The Phase 0 Vercel Node.js runtime requires only `TOKEN_ENCRYPTION_KEY` as a server-only secret. It uses the user's RLS-scoped Supabase session, not a service-role key. Google OAuth client credentials remain in Supabase Auth and are not duplicated in Vercel.
- `.env`, `.dev.vars`, private keys, service accounts, and credential JSON are ignored.
- Production secrets must be stored with Cloudflare Secrets or an approved secret manager.

## Known Phase 0 limitations

- CSP currently permits inline styles/scripts required by the initial Next.js runtime. Replace with nonce-based CSP during hardening.
- Rate limiting, Google webhook verification, and transcript retention enforcement belong to later phases. Encrypted Google refresh-token storage is implemented in Phase 0.
- Remote rollback-only RLS tests cover inactive, no-membership, cross-organization, and FS_MEMBER-to-ADMIN database denials. Separate authenticated browser sessions for each denied identity have not yet been exercised.
- An earlier local build loaded ignored `.env.local`, causing OpenNext's `.open-next/cloudflare/next-env.mjs` intermediate to contain the local key. The code now obtains the key from the Worker runtime binding, and release builds must run without server-only `.env.local` values. A clean canary build yielded zero canary hits in `.next` and `.open-next`; a Wrangler dry-run upload and scan yielded zero actual-key hits. A future build with `.env.local` present may still contaminate an intermediate, so isolated release builds are mandatory.
