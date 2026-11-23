-- M7.2: batch preparation queue. One row per dispatch of the batch (prepared one per invocation, in series).
-- Pending confirmations that belong to a batch carry lote_id, so they never supersede (or get superseded by) single-dispatch ones.
alter table public.ia_pendientes add column if not exists lote_id uuid;
create index if not exists ia_pendientes_lote on public.ia_pendientes (lote_id) where lote_id is not null;
alter table public.ia_lotes add column if not exists phone text;
alter table public.ia_lotes add column if not exists updated_at timestamptz not null default now();

create table if not exists public.ia_lote_items (
  id uuid primary key default gen_random_uuid(),
  lote_id uuid not null references public.ia_lotes (id) on delete cascade,
  n int not null,
  numero text not null,
  input jsonb not null,
  status text not null default 'PENDING', -- PENDING | PREPARING | READY | REJECTED | CANCELLED
  attempts int not null default 0,
  error_code text,
  error_text text,
  pendiente_id uuid,
  ms int,
  updated_at timestamptz not null default now(),
  unique (lote_id, n)
);
alter table public.ia_lote_items enable row level security;
comment on table public.ia_lote_items is 'Rows of a batch dispatch (M7). RLS on, no policies: only the service key reads or writes.';
