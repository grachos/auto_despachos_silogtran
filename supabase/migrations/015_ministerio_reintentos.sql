-- «Enviar Ministerio» resends done through the app (WhatsApp / MCP): counted per manifest, capped in code (3).
alter table public.silog_confirmaciones add column if not exists ministerio_reintentos integer not null default 0;
alter table public.silog_confirmaciones add column if not exists ministerio_reintento_at timestamptz;
comment on column public.silog_confirmaciones.ministerio_reintentos is 'How many times «Enviar Ministerio» was resent for this manifest through the app (cap 3).';
