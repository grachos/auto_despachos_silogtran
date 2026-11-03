-- Dispatch metrics (per confirmation) for the admin panel + admin login rate limiting.
alter table public.silog_confirmaciones
  add column if not exists user_id uuid references public.app_users (id) on delete set null,
  add column if not exists placa text,
  add column if not exists solicitud_item int,
  add column if not exists anticipo_modo text,          -- 'total' | 'cero'
  add column if not exists anticipo_valor numeric,
  add column if not exists orden_cargue text,
  add column if not exists remesa text,
  add column if not exists manifiesto text,
  add column if not exists transferencia text,
  add column if not exists radicado text,               -- Ministry filing number (RNDC), null until migrated
  add column if not exists rndc_migrated boolean,
  add column if not exists rndc_fecha_hora text,        -- as reported by Silogtran
  add column if not exists rndc_checked_at timestamptz,
  add column if not exists prepare_ms int,              -- fill the form (preparar part of confirmar)
  add column if not exists save_ms int,                 -- press Grabar until the result page
  add column if not exists total_ms int,                -- claim -> saved (excludes the RNDC read)
  add column if not exists error_code text;
create index if not exists silog_confirmaciones_created on public.silog_confirmaciones (created_at desc);
create index if not exists silog_confirmaciones_user on public.silog_confirmaciones (user_id, created_at desc);

-- Backfill rows saved before the metrics existed (total_ms is approximate: it includes the RNDC read).
update public.silog_confirmaciones set
  orden_cargue = result->'documents'->>'ordenCargue',
  remesa = result->'documents'->>'remesa',
  manifiesto = result->'documents'->>'manifiesto',
  transferencia = result->'documents'->>'transferencia',
  radicado = result->'rndc'->>'radicado',
  rndc_migrated = (result->'rndc'->>'migrated')::boolean,
  rndc_fecha_hora = result->'rndc'->>'fechaHora',
  total_ms = (extract(epoch from (updated_at - created_at)) * 1000)::int
where status = 'DONE' and result is not null and manifiesto is null;

create table if not exists public.admin_intentos (
  id uuid primary key default gen_random_uuid(),
  ip text not null,
  created_at timestamptz not null default now()
);
create index if not exists admin_intentos_ip on public.admin_intentos (ip, created_at desc);
alter table public.admin_intentos enable row level security;
comment on table public.admin_intentos is 'Failed admin-panel logins per IP for rate limiting (server-side access only).';
