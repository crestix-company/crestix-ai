# Architecture

Phase 0 is a single Next.js App Router application deployed to Cloudflare Workers through OpenNext. Supabase provides PostgreSQL and Google-backed authentication.

```text
Browser
  -> Cloudflare Worker / Next.js
     -> Supabase Auth
     -> Supabase Postgres (RLS)
```

Server Components perform reads directly. Server Actions handle internal mutations. Route Handlers are reserved for OAuth callbacks and later third-party webhooks. Authorization is enforced both server-side and in PostgreSQL RLS.

Calendar, background jobs, AI preparation, and live assistance are deliberately absent from Phase 0 and will be added behind provider-neutral interfaces.
