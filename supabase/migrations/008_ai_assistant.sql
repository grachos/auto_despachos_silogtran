-- M5 (additive only): short chat history, pending dispatches awaiting a button press, per-user usage counters.
create table if not exists public.ia_mensajes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);
create index if not exists ia_mensajes_user on public.ia_mensajes (user_id, created_at desc);

-- A prepared dispatch waits here (token stays server-side, never shown to the model) until the user taps a button.
create table if not exists public.ia_pendientes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users (id) on delete cascade,
  numero text not null,
  token text not null,
  resumen jsonb not null,
  anticipo_sugerido numeric not null,
  status text not null default 'PENDING' check (status in ('PENDING', 'PROCESSING', 'USED', 'CANCELLED', 'SUPERSEDED')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists ia_pendientes_user on public.ia_pendientes (user_id, created_at desc);

create table if not exists public.ia_uso (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users (id) on delete cascade,
  kind text not null check (kind in ('msg', 'voz')),
  created_at timestamptz not null default now()
);
create index if not exists ia_uso_user on public.ia_uso (user_id, kind, created_at desc);

alter table public.ia_mensajes enable row level security;
alter table public.ia_pendientes enable row level security;
alter table public.ia_uso enable row level security;
comment on table public.ia_mensajes is 'Short WhatsApp assistant chat history (server-side access only).';
comment on table public.ia_pendientes is 'Prepared dispatches awaiting a confirmation button (server-side access only).';
comment on table public.ia_uso is 'Per-user AI usage counters for rate limiting (server-side access only).';
