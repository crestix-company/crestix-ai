begin;

create policy jobs_deny_authenticated
on public.jobs
for all
to authenticated
using (false)
with check (false);

commit;
