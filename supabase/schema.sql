create extension if not exists pgcrypto;
create schema if not exists app_private;
revoke all on schema app_private from public;

create table if not exists public.rooms (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  provider text check (provider in ('youtube', 'vimeo')),
  video_id text,
  video_hash text not null default '',
  status text not null default 'paused' check (status in ('playing', 'paused')),
  position double precision not null default 0 check (position >= 0),
  anchor_time timestamptz not null default clock_timestamp(),
  execute_at timestamptz,
  version bigint not null default 0,
  updated_at timestamptz not null default clock_timestamp(),
  check ((provider is null and video_id is null) or (provider is not null and video_id is not null)),
  check (length(video_id) <= 128),
  check (length(video_hash) <= 128)
);

create table if not exists app_private.room_admin_codes (
  room_id text primary key references public.rooms(id) on delete cascade,
  admin_code_hash text not null
);

alter table public.rooms enable row level security;
alter table app_private.room_admin_codes enable row level security;

drop policy if exists "no direct access to admin codes" on app_private.room_admin_codes;
create policy "no direct access to admin codes"
on app_private.room_admin_codes for all
to public
using (false)
with check (false);

drop policy if exists "rooms are publicly readable" on public.rooms;
create policy "rooms are publicly readable"
on public.rooms for select
to anon, authenticated
using (true);

create or replace function public.server_time_ms()
returns bigint
language sql
stable
security invoker
set search_path = ''
as $$
  select floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
$$;

create or replace function app_private.control_room(
  p_room_id text,
  p_admin_code text,
  p_state jsonb
)
returns public.rooms
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room public.rooms;
  v_admin_code_hash text;
  v_provider text;
  v_status text;
  v_position double precision;
  v_anchor_ms bigint;
  v_execute_ms bigint;
begin
  select * into v_room
  from public.rooms
  where id = p_room_id
  for update;

  if not found then
    raise exception 'room not found';
  end if;

  select admin_code_hash into v_admin_code_hash
  from app_private.room_admin_codes
  where room_id = p_room_id;

  if v_admin_code_hash is null
     or v_admin_code_hash <> extensions.crypt(p_admin_code, v_admin_code_hash) then
    raise exception 'invalid admin code';
  end if;

  v_provider := nullif(p_state ->> 'provider', '');
  v_status := coalesce(nullif(p_state ->> 'status', ''), 'paused');
  v_position := greatest(coalesce((p_state ->> 'position')::double precision, 0), 0);
  v_anchor_ms := coalesce((p_state ->> 'anchorTime')::bigint, public.server_time_ms());
  v_execute_ms := nullif(p_state ->> 'executeAt', '')::bigint;

  if v_provider is not null and v_provider not in ('youtube', 'vimeo') then
    raise exception 'invalid provider';
  end if;
  if v_status not in ('playing', 'paused') then
    raise exception 'invalid status';
  end if;
  if v_position < 0 or v_position > 8640000 then
    raise exception 'invalid position';
  end if;

  update public.rooms
  set provider = v_provider,
      video_id = nullif(p_state ->> 'videoId', ''),
      video_hash = coalesce(p_state ->> 'hash', ''),
      status = v_status,
      position = v_position,
      anchor_time = to_timestamp(v_anchor_ms / 1000.0),
      execute_at = case when v_execute_ms is null then null else to_timestamp(v_execute_ms / 1000.0) end,
      version = version + 1,
      updated_at = clock_timestamp()
  where id = p_room_id
  returning * into v_room;

  return v_room;
end;
$$;

revoke all on function app_private.control_room(text, text, jsonb) from public;
grant usage on schema app_private to anon, authenticated;
grant execute on function app_private.control_room(text, text, jsonb) to anon, authenticated;

create or replace function public.control_room(
  p_room_id text,
  p_admin_code text,
  p_state jsonb
)
returns public.rooms
language sql
security invoker
set search_path = ''
as $$
  select app_private.control_room(p_room_id, p_admin_code, p_state);
$$;

revoke all on function public.control_room(text, text, jsonb) from public;
grant execute on function public.control_room(text, text, jsonb) to anon, authenticated;
grant execute on function public.server_time_ms() to anon, authenticated;
grant select on public.rooms to anon, authenticated;

-- 実行前に YOUR_ADMIN_CODE を十分長い管理コードへ置換する。
insert into public.rooms (id)
values ('test001')
on conflict (id) do nothing;

insert into app_private.room_admin_codes (room_id, admin_code_hash)
values ('test001', extensions.crypt('YOUR_ADMIN_CODE', extensions.gen_salt('bf', 10)))
on conflict (room_id) do update
set admin_code_hash = excluded.admin_code_hash;

do $$
begin
  alter publication supabase_realtime add table public.rooms;
exception
  when duplicate_object then null;
end $$;
