begin;

alter table public.calendar_watch_channels
  add column pending_page_token text;

commit;
