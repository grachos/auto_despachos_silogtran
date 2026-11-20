-- A person may link up to 2 WhatsApp numbers (the limit is enforced by the app; the phone stays unique across accounts).
-- Before: user_id was the primary key (one phone per user). Now each link has its own id and user_id is just indexed.
alter table public.vinculos_whatsapp add column if not exists id uuid not null default gen_random_uuid();
alter table public.vinculos_whatsapp drop constraint if exists vinculos_whatsapp_pkey;
alter table public.vinculos_whatsapp add primary key (id);
create index if not exists vinculos_whatsapp_user on public.vinculos_whatsapp (user_id);
comment on table public.vinculos_whatsapp is 'Phone <-> app user links, up to 2 phones per user, a phone belongs to one user (server-side access only).';
