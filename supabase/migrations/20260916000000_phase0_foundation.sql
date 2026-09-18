begin;

create type public.organization_role as enum ('ADMIN', 'FS_MANAGER', 'FS_MEMBER');
create type public.organization_department as enum ('FIRST_DIVISION');
create type public.organization_team as enum ('FS');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_email_not_blank check (btrim(email) <> '')
);

create unique index profiles_email_unique_ci on public.profiles (lower(email));

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now(),
  constraint organizations_name_not_blank check (btrim(name) <> '')
);

create table public.organization_memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  department public.organization_department not null default 'FIRST_DIVISION',
  team public.organization_team not null default 'FS',
  role public.organization_role not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (organization_id, user_id)
);

create index organization_memberships_active_user_idx
  on public.organization_memberships (user_id, organization_id)
  where is_active;

create schema app_private;
revoke all on schema app_private from public, anon, authenticated;
grant usage on schema app_private to authenticated;

create function app_private.is_active_member(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null and exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = target_organization_id
      and membership.user_id = (select auth.uid())
      and membership.is_active
  );
$$;

create function app_private.has_org_role(
  target_organization_id uuid,
  allowed_roles public.organization_role[]
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null and exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = target_organization_id
      and membership.user_id = (select auth.uid())
      and membership.is_active
      and membership.role = any(allowed_roles)
  );
$$;

revoke all on function app_private.is_active_member(uuid) from public;
revoke all on function app_private.has_org_role(uuid, public.organization_role[]) from public;
grant execute on function app_private.is_active_member(uuid) to authenticated;
grant execute on function app_private.has_org_role(uuid, public.organization_role[]) to authenticated;

alter table public.profiles enable row level security;
alter table public.organizations enable row level security;
alter table public.organization_memberships enable row level security;

create policy profiles_select_same_organization
on public.profiles for select
to authenticated
using (
  id = (select auth.uid())
  or exists (
    select 1
    from public.organization_memberships target_membership
    where target_membership.user_id = profiles.id
      and target_membership.is_active
      and app_private.is_active_member(target_membership.organization_id)
  )
);

create policy organizations_select_member
on public.organizations for select
to authenticated
using (app_private.is_active_member(id));

create policy memberships_select_same_organization
on public.organization_memberships for select
to authenticated
using (app_private.is_active_member(organization_id));

create policy memberships_insert_admin
on public.organization_memberships for insert
to authenticated
with check (
  app_private.has_org_role(organization_id, array['ADMIN']::public.organization_role[])
);

create policy memberships_update_admin
on public.organization_memberships for update
to authenticated
using (
  app_private.has_org_role(organization_id, array['ADMIN']::public.organization_role[])
)
with check (
  app_private.has_org_role(organization_id, array['ADMIN']::public.organization_role[])
);

create policy memberships_delete_admin
on public.organization_memberships for delete
to authenticated
using (
  app_private.has_org_role(organization_id, array['ADMIN']::public.organization_role[])
);

revoke all on public.profiles from anon;
revoke all on public.organizations from anon;
revoke all on public.organization_memberships from anon;
grant select on public.profiles to authenticated;
grant select on public.organizations to authenticated;
grant select, insert, update, delete on public.organization_memberships to authenticated;

commit;
