
begin;

create index agent_runs_skill_version_idx
  on public.agent_runs (skill_version_id);

create index meeting_preparations_skill_version_idx
  on public.meeting_preparations (skill_version_id);

create policy skills_deny_authenticated
on public.skills
for all
to authenticated
using (false)
with check (false);

create policy skill_versions_deny_authenticated
on public.skill_versions
for all
to authenticated
using (false)
with check (false);

create policy agent_runs_deny_authenticated
on public.agent_runs
for all
to authenticated
using (false)
with check (false);

commit;
