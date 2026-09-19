begin;

alter table public.meeting_preparations
  add column source_mode text not null default 'MANUAL_CHATGPT';

alter table public.meeting_preparations
  add constraint meeting_preparations_source_mode_check
  check (source_mode in ('MANUAL_CHATGPT', 'API'));

commit;
