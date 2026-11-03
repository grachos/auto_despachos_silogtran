-- Webhook support: processed message ids (dedupe, Meta retries) and failed link-code attempts per phone.
create table if not exists public.whatsapp_mensajes (
  message_id text primary key,
  created_at timestamptz not null default now()
);
create index if not exists whatsapp_mensajes_created on public.whatsapp_mensajes (created_at);

create table if not exists public.whatsapp_intentos (
  id uuid primary key default gen_random_uuid(),
  phone text not null,
  created_at timestamptz not null default now()
);
create index if not exists whatsapp_intentos_phone on public.whatsapp_intentos (phone, created_at desc);

alter table public.whatsapp_mensajes enable row level security;
alter table public.whatsapp_intentos enable row level security;
comment on table public.whatsapp_mensajes is 'Processed WhatsApp message ids for webhook dedupe (server-side access only).';
comment on table public.whatsapp_intentos is 'Failed VINCULAR attempts per phone for rate limiting (server-side access only).';
