-- Where each dispatch was confirmed from: api | whatsapp | mcp (null = rows before this migration).
alter table public.silog_confirmaciones add column if not exists origen text;
comment on column public.silog_confirmaciones.origen is 'Where the dispatch was confirmed from: api | whatsapp | mcp (null = rows before migration 014).';
