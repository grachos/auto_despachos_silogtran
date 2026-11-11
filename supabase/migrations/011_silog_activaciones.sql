-- Audit trail of the activation MCP (vehicles now, third parties later): one row per tool call that tried to change something.
create table if not exists public.silog_activaciones (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  tipo text not null,            -- 'vehiculo' | 'tercero'
  referencia text not null,      -- plate / document
  actor text,                    -- Silogtran user used ('default' = user zero)
  resultado text not null,       -- 'ACTIVATED' | 'ALREADY_ACTIVE' | 'REFUSED' | 'ERROR'
  error_code text,
  detalle text,                  -- short text (missing documents, etc.); never credentials
  ms integer
);
alter table public.silog_activaciones enable row level security; -- no policies: only the service key reads/writes
create index if not exists silog_activaciones_created_idx on public.silog_activaciones (created_at desc);
