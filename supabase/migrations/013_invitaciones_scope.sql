-- Each invitation link is for ONE purpose (independent links): 'whatsapp' | 'activar' (vehicles + providers) | 'despachar' (later).
alter table public.invitaciones add column if not exists scope text not null default 'whatsapp';
alter table public.invitaciones drop constraint if exists invitaciones_scope_check;
alter table public.invitaciones add constraint invitaciones_scope_check check (scope in ('whatsapp', 'activar', 'despachar'));
