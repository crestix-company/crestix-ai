begin;
create policy user_feature_flags_deny_authenticated
on public.user_feature_flags
for all
to authenticated
using (false)
with check (false);
commit;
