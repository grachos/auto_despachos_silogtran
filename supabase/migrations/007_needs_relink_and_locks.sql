-- M4 (additive only). A user whose stored Silogtran password stopped working is flagged with
-- relink_required = true and status 'DISABLED' (so every existing "is ACTIVE?" check fails safe);
-- the flag only selects the message shown. Re-inviting the user (successful login) clears both.
alter table public.app_users add column if not exists relink_required boolean not null default false;

-- Mutex per Silogtran cookie jar (one per user, plus 'default' = user zero).
create table if not exists public.silog_locks (
  key text primary key,            -- user id, or 'default' for user zero
  token text not null,             -- owner token: only the owner can release
  expires_at timestamptz not null  -- TTL > function max duration; an expired lock can be reclaimed
);
alter table public.silog_locks enable row level security;
comment on table public.silog_locks is 'Mutex per Silogtran session (server-side access only).';
