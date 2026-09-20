begin;

-- Phase 0/1 migrations revoked ALL from `anon` before granting the intended
-- SELECT to `authenticated`, but never ran the equivalent revoke for
-- `authenticated` itself - so schema-level default privileges left
-- INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER in place on top of the
-- intended SELECT grant. RLS has been blocking any actual write on these
-- tables the whole time (no INSERT/UPDATE/DELETE policy exists for
-- `authenticated` on any of them), so this changes no runtime behavior -
-- it only removes needless privilege surface, matching the pattern phase2
-- migrations already used correctly (revoke all, then grant exactly what's
-- needed).
revoke all on public.calendar_events from authenticated;
revoke all on public.calendar_watch_channels from authenticated;
revoke all on public.clinics from authenticated;
revoke all on public.meetings from authenticated;
revoke all on public.organizations from authenticated;

grant select on public.calendar_events to authenticated;
grant select on public.calendar_watch_channels to authenticated;
grant select on public.clinics to authenticated;
grant select on public.meetings to authenticated;
grant select on public.organizations to authenticated;

-- profiles/google_connections DO have genuine self-service RLS policies
-- (profiles_insert_self, profiles_update_self, google_connections_insert_self,
-- google_connections_update_self) - keep exactly SELECT/INSERT/UPDATE,
-- dropping only the unused DELETE/TRUNCATE/REFERENCES/TRIGGER grants that
-- have no matching policy.
revoke all on public.profiles from authenticated;
grant select, insert, update on public.profiles to authenticated;

revoke all on public.google_connections from authenticated;
grant select, insert, update on public.google_connections to authenticated;

commit;
