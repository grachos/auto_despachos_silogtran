-- App users (each with their own Silogtran credentials, encrypted) and single-use invitations.
create table if not exists public.app_users (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  silog_user text,
  silog_user_key text,              -- lower(silog_user): one app user per Silogtran user
  silog_password_enc text,          -- v1:iv:tag:ciphertext (AES-256-GCM, AAD = id)
  status text not null default 'PENDING' check (status in ('PENDING', 'ACTIVE', 'DISABLED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists app_users_silog_user_key on public.app_users (silog_user_key) where silog_user_key is not null;

create table if not exists public.invitaciones (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users (id) on delete cascade,
  token_hash text not null unique,  -- sha256 hex of the raw token; the raw token is never stored
  expires_at timestamptz not null,
  used_at timestamptz,
  attempts int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists invitaciones_user_id on public.invitaciones (user_id);

alter table public.app_users enable row level security;
alter table public.invitaciones enable row level security;
comment on table public.app_users is 'App users with encrypted Silogtran credentials (server-side access only).';
comment on table public.invitaciones is 'Single-use invitation links, 2 h expiry, max 5 login attempts (server-side access only).';
