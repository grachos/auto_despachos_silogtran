-- One row per confirmed token (idempotency) + per-request lock while a dispatch is being saved.
create table if not exists public.silog_confirmaciones (
  token_id text primary key,
  numero text not null,
  status text not null check (status in ('PROCESSING', 'DONE', 'FAILED', 'UNKNOWN')),
  result jsonb,
  detail text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Only one confirmation in flight per request number.
create unique index if not exists silog_confirmaciones_numero_processing
  on public.silog_confirmaciones (numero) where status = 'PROCESSING';
alter table public.silog_confirmaciones enable row level security;
comment on table public.silog_confirmaciones is 'Confirmation idempotency and per-request lock for auto_despachos_silogtran (server-side access only).';
