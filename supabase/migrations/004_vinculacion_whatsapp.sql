-- WhatsApp linking: short-lived one-time codes (stored as HMAC, never raw) and the resulting link.
create table if not exists public.codigos_vinculacion (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users (id) on delete cascade,
  code_hash text not null unique,   -- HMAC-SHA256(TOKEN_SECRET, 6-digit code)
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists codigos_vinculacion_user on public.codigos_vinculacion (user_id, created_at desc);

create table if not exists public.vinculos_whatsapp (
  user_id uuid primary key references public.app_users (id) on delete cascade,
  phone text not null unique,       -- E.164 digits, filled by the WhatsApp webhook (M3)
  linked_at timestamptz not null default now()
);

alter table public.codigos_vinculacion enable row level security;
alter table public.vinculos_whatsapp enable row level security;
comment on table public.codigos_vinculacion is 'One-time WhatsApp linking codes, 10 min expiry (server-side access only).';
comment on table public.vinculos_whatsapp is 'Phone <-> app user link (server-side access only).';
