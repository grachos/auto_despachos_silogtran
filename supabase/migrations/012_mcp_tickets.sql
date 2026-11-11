-- MCP access per person: the administrator enables a scope per user; the person generates a one-time ticket (15 min) that becomes a revocable
-- connection. Tickets are stored only as HMAC. Every MCP call checks the connection is not revoked (immediate revocation).
create table if not exists public.mcp_permisos (
  user_id uuid not null references public.app_users (id) on delete cascade,
  scope text not null,
  granted_at timestamptz not null default now(),
  primary key (user_id, scope)
);
create table if not exists public.mcp_tickets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users (id) on delete cascade,
  scope text not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists mcp_tickets_user_idx on public.mcp_tickets (user_id, created_at desc);
create table if not exists public.mcp_conexiones (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users (id) on delete cascade,
  scope text not null,
  label text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index if not exists mcp_conexiones_user_idx on public.mcp_conexiones (user_id, scope) where revoked_at is null;
alter table public.mcp_permisos enable row level security;
alter table public.mcp_tickets enable row level security;
alter table public.mcp_conexiones enable row level security;
-- who activated, for the audit table of the activation MCP
alter table public.silog_activaciones add column if not exists user_id uuid;
alter table public.silog_activaciones add column if not exists conexion_id uuid;
