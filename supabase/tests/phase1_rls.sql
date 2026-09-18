begin;

insert into auth.users (id, email) values
  ('01000000-0000-0000-0000-000000000001', 'phase1-member-a@example.invalid'),
  ('01000000-0000-0000-0000-000000000002', 'phase1-member-b@example.invalid'),
  ('01000000-0000-0000-0000-000000000003', 'phase1-manager@example.invalid'),
  ('01000000-0000-0000-0000-000000000004', 'phase1-other-admin@example.invalid'),
  ('01000000-0000-0000-0000-000000000005', 'phase1-same-org-admin@example.invalid');

insert into public.profiles (id, email) values
  ('01000000-0000-0000-0000-000000000001', 'phase1-member-a@example.invalid'),
  ('01000000-0000-0000-0000-000000000002', 'phase1-member-b@example.invalid'),
  ('01000000-0000-0000-0000-000000000003', 'phase1-manager@example.invalid'),
  ('01000000-0000-0000-0000-000000000004', 'phase1-other-admin@example.invalid'),
  ('01000000-0000-0000-0000-000000000005', 'phase1-same-org-admin@example.invalid');

insert into public.organizations (id, name) values
  ('11000000-0000-0000-0000-000000000001', 'Phase1 Org A'),
  ('11000000-0000-0000-0000-000000000002', 'Phase1 Org B');

insert into public.organization_memberships (organization_id, user_id, role) values
  ('11000000-0000-0000-0000-000000000001', '01000000-0000-0000-0000-000000000001', 'FS_MEMBER'),
  ('11000000-0000-0000-0000-000000000001', '01000000-0000-0000-0000-000000000002', 'FS_MEMBER'),
  ('11000000-0000-0000-0000-000000000001', '01000000-0000-0000-0000-000000000003', 'FS_MANAGER'),
  ('11000000-0000-0000-0000-000000000002', '01000000-0000-0000-0000-000000000004', 'ADMIN'),
  ('11000000-0000-0000-0000-000000000001', '01000000-0000-0000-0000-000000000005', 'ADMIN');

insert into public.google_connections (
  id, user_id, google_email, encrypted_refresh_token
) values (
  '21000000-0000-0000-0000-000000000001',
  '01000000-0000-0000-0000-000000000001',
  'phase1-member-a@example.invalid',
  'ciphertext'
);

insert into public.calendar_events (
  id, google_connection_id, google_event_id, title, event_status
) values (
  '31000000-0000-0000-0000-000000000001',
  '21000000-0000-0000-0000-000000000001',
  'event-a',
  '【お打ち合わせ①】テスト医院 様',
  'confirmed'
);

insert into public.meetings (
  id, calendar_event_id, fs_user_id, organization_id, meeting_type, status
) values (
  '41000000-0000-0000-0000-000000000001',
  '31000000-0000-0000-0000-000000000001',
  '01000000-0000-0000-0000-000000000001',
  '11000000-0000-0000-0000-000000000001',
  'E1',
  'DETECTED'
);

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);

select set_config('request.jwt.claim.sub', '01000000-0000-0000-0000-000000000001', true);
do $$
begin
  if (select count(*) from public.meetings where id='41000000-0000-0000-0000-000000000001') <> 1 then
    raise exception 'FS_MEMBER must read own meeting';
  end if;
end $$;

select set_config('request.jwt.claim.sub', '01000000-0000-0000-0000-000000000002', true);
do $$
begin
  if exists (select 1 from public.meetings where id='41000000-0000-0000-0000-000000000001') then
    raise exception 'FS_MEMBER must not read another FS member meeting';
  end if;
end $$;

select set_config('request.jwt.claim.sub', '01000000-0000-0000-0000-000000000003', true);
do $$
begin
  if (select count(*) from public.meetings where id='41000000-0000-0000-0000-000000000001') <> 1 then
    raise exception 'FS_MANAGER must read same-org FS meeting';
  end if;
end $$;

select set_config('request.jwt.claim.sub', '01000000-0000-0000-0000-000000000004', true);
do $$
begin
  if exists (select 1 from public.meetings where id='41000000-0000-0000-0000-000000000001') then
    raise exception 'Other-org ADMIN must not read meeting';
  end if;
end $$;

select set_config('request.jwt.claim.sub', '01000000-0000-0000-0000-000000000005', true);
do $$
begin
  if (select count(*) from public.meetings where id='41000000-0000-0000-0000-000000000001') <> 1 then
    raise exception 'Same-org ADMIN must read same-org FS meeting';
  end if;
end $$;

rollback;
