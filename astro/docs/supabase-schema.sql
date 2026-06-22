-- rhyolite-MELTS Tracker — Supabase schema
-- Run this in the Supabase SQL editor (one-shot).
--
-- Model: a single canonical snapshot row (id='main') holding the whole S blob.
-- Every overwrite copies the previous row into snapshot_history for undo/audit.
-- Public can read; only the service_role key (used by the Vercel API) can write.

create table if not exists snapshots (
  id          text primary key,
  data        jsonb       not null,
  updated_at  timestamptz not null default now(),
  updated_by  text                                  -- free-form label, e.g. 'admin'
);

create table if not exists snapshot_history (
  id            bigserial primary key,
  snapshot_id   text        not null,
  data          jsonb       not null,
  saved_at      timestamptz not null default now(),
  saved_by      text,
  note          text
);

create index if not exists snapshot_history_sid_idx
  on snapshot_history (snapshot_id, saved_at desc);

-- Before each UPDATE on snapshots, archive the OLD row to history.
create or replace function snapshots_archive_old() returns trigger
language plpgsql as $$
begin
  insert into snapshot_history (snapshot_id, data, saved_at, saved_by)
  values (old.id, old.data, old.updated_at, old.updated_by);
  return new;
end $$;

drop trigger if exists snapshots_archive on snapshots;
create trigger snapshots_archive
  before update on snapshots
  for each row execute function snapshots_archive_old();

-- Row-level security: public can SELECT; writes go through service_role.
alter table snapshots         enable row level security;
alter table snapshot_history  enable row level security;

drop policy if exists "snapshots public read" on snapshots;
create policy "snapshots public read"
  on snapshots for select
  using (true);

drop policy if exists "history public read" on snapshot_history;
create policy "history public read"
  on snapshot_history for select
  using (true);

-- Seed the canonical row so GET /api/snapshot returns something on day one.
insert into snapshots (id, data, updated_by)
values ('main', '{}'::jsonb, 'seed')
on conflict (id) do nothing;
