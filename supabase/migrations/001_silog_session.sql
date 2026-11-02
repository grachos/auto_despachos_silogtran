-- Stored Silogtran cookie jar (one row). Accessed only with the service key: RLS on, no policies.
create table if not exists public.silog_session (
  id text primary key,
  cookies jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.silog_session enable row level security;
comment on table public.silog_session is 'Silogtran cookie jar for auto_despachos_silogtran (server-side access only).';
