-- Vehicle source of each dispatch ('activos' | 'empresas'). Dispatches loaded through the Empresas tab are NOT reported to the
-- Ministry (RNDC), so the admin panel and the Ministry re-reader must skip them. Null = Vehículos Activos (rows before this column).
alter table public.silog_confirmaciones add column if not exists fuente text;

-- Back-fill: the signed token kept for the assistant carries input.fuente and the jti that is silog_confirmaciones.token_id.
update public.silog_confirmaciones c
set fuente = 'empresas'
from (
  select (convert_from(decode(translate(split_part(token, '.', 1), '-_', '+/')
           || repeat('=', (4 - length(split_part(token, '.', 1)) % 4) % 4), 'base64'), 'utf8'))::jsonb as payload
  from public.ia_pendientes
  where token like '%.%'
) p
where p.payload ->> 'jti' = c.token_id
  and p.payload -> 'input' ->> 'fuente' = 'empresas'
  and c.fuente is null;
