-- M7.1: drafts of multi-dispatch batches read from a table the person sent by WhatsApp (server-side access only).
-- filas = validated rows (jsonb array); texto = the original message (so later steps can check what the person actually stated).
create table if not exists public.ia_lotes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users (id) on delete cascade,
  status text not null default 'DRAFT',
  filas jsonb not null,
  texto text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists ia_lotes_user_created on public.ia_lotes (user_id, created_at desc);
alter table public.ia_lotes enable row level security;
comment on table public.ia_lotes is 'Batch dispatch drafts (M7). RLS on, no policies: only the service key reads or writes.';
