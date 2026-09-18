begin;

-- This test file is designed for `supabase test db`/pgTAP once local Supabase is available.
-- IDs are deterministic fixtures, not real users.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000001', 'member@example.invalid'),
  ('00000000-0000-0000-0000-000000000002', 'other@example.invalid');

insert into public.profiles (id, email) values
  ('00000000-0000-0000-0000-000000000001', 'member@example.invalid'),
  ('00000000-0000-0000-0000-000000000002', 'other@example.invalid');

insert into public.organizations (id, name) values
  ('10000000-0000-0000-0000-000000000001', 'Organization A'),
  ('10000000-0000-0000-0000-000000000002', 'Organization B');

insert into public.organization_memberships (organization_id, user_id, role) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'FS_MEMBER'),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000002', 'ADMIN');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

do $$
begin
  if (select count(*) from public.organizations) <> 1 then
    raise exception 'RLS must expose only the current organization';
  end if;
  if exists (
    select 1 from public.organization_memberships
    where organization_id = '10000000-0000-0000-0000-000000000002'
  ) then
    raise exception 'Cross-organization membership leaked';
  end if;
end;
$$;

rollback;
