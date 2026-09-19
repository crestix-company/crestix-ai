begin;
update public.user_feature_flags
set config = config || '{"include_private_calendar_notes":false,"material_mode":"INTERNAL_E1_BRIEF"}'::jsonb,
    updated_at = now()
where feature_key='FS_AUTO_PREPARATION';
commit;
