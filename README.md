# auto_despachos_silogtran

API para que una IA confirme y despache solicitudes de transporte en **Silogtran** (TMS PRADO/PHP, sin API oficial) mediante scraping HTTP. Pensada para Vercel (plan gratuito) con sesión de Silogtran persistida en Supabase.

> Contexto técnico completo, flujo de despacho validado y notas del HTML real: ver [`CLAUDE.md`](./CLAUDE.md).

## Endpoints
Todos requieren el header `x-api-key`. Los errores responden `{ ok:false, code, message }` (mensaje en español, `code` fijo).

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/api/health` | Valida configuración, Supabase, reto AWS WAF y login en Silogtran |
| GET | `/api/solicitudes/:numero` | Lee la solicitud (contenedor sí/no, ítems con origen/destino y vehículos pendientes). Solo lectura |
| POST | `/api/solicitudes/:numero/preparar` | Llena todo el despacho **sin grabar**; devuelve resumen y un `token` (vence a los 15 min) |
| POST | `/api/solicitudes/:numero/confirmar` | Con `{ token, anticipo: "total"\|"cero" }` rehace el llenado, verifica el anticipo, **graba** y consulta el estado del RNDC |

`preparar` recibe `{ placa, citaCargue{fecha,hora}, citaDescargue{fecha,hora}, tipoManifiesto?, ordenCompra?, observacionOrdenCargue?, observacionRemesa?, contenedor?, bl?, item? }`. Las citas son obligatorias; `contenedor` y `bl` lo son si la solicitud lo requiere. `tipoManifiesto` por defecto: 6 (municipal/urbano) si origen = destino, si no 1 (general).

```bash
curl -s -X POST -H "x-api-key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"placa":"KNL058","citaCargue":{"fecha":"2026-11-08","hora":"14:00"},"citaDescargue":{"fecha":"2026-11-10","hora":"16:00"}}' \
  https://auto-despachos-silogtran.vercel.app/api/solicitudes/NUMERO/preparar

curl -s -X POST -H "x-api-key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"token":"TOKEN_DE_PREPARAR","anticipo":"cero"}' \
  https://auto-despachos-silogtran.vercel.app/api/solicitudes/NUMERO/confirmar
```

### Protecciones de `confirmar`
- Un token se confirma **una sola vez**; repetirlo devuelve el resultado guardado (`repeated: true`).
- Una solicitud a la vez (`SOLICITUD_LOCKED`).
- Si el resultado del guardado es dudoso queda `UNKNOWN` y **no se reintenta solo**: verificar en Silogtran y usar un token nuevo.
- `ANTICIPO_CHANGED` si el anticipo recalculado difiere del que se vio en `preparar`.

## Multiusuario (en construcción)
| Método | Ruta | Qué hace |
|---|---|---|
| POST | `/api/admin/invitaciones` | (`ADMIN_KEY`) crea un usuario y un link de un solo uso que vence a las 2 h |
| POST | `/api/invitaciones/:token/login` | la persona prueba su usuario y contraseña de Silogtran; se guardan cifrados y se abre sesión web |

| POST | `/api/vinculacion/codigo` | (cookie de sesión) genera el código `VINCULAR 123456` (10 min) |
| GET/POST | `/api/whatsapp/webhook` | webhook de WhatsApp Cloud API (verificación de Meta y mensajes; valida la firma) |
| GET | `/api/vinculacion/estado` | (cookie de sesión) indica si el WhatsApp ya está vinculado |

Pantallas: `/invitacion/<token>`, `/vincular`, `/manual` y `/privacidad` (públicas) y `/admin`.

Siguientes pasos: webhook de WhatsApp, API por usuario e IA (ver roadmap en `CLAUDE.md`).

## Variables de entorno
Ver [`.env.example`](./.env.example) (sin valores). En Vercel, marcarlas para **Production** (y Preview si se prueba ahí) y volver a desplegar tras cambiarlas.

`SILOG_BASE_URL`, `SILOG_USER`, `SILOG_PASSWORD`, `API_KEY`, `TOKEN_SECRET`, `ENCRYPTION_KEY`, `ADMIN_KEY`, `WHATSAPP_NUMBER`, `WHATSAPP_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_PHONE_ID`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (clave `service_role`/secret, nunca la `anon`/publishable).

## Estructura
```
api/                         funciones serverless de Vercel
src/silogtran/               cliente HTTP, WAF, sesión, formulario PRADO, pasos del despacho
src/store/                   Supabase: sesión y confirmaciones
src/confirmar.js             orquestación de confirmar
supabase/migrations/         tablas silog_session y silog_confirmaciones
```
El reto AWS WAF se resuelve con `@sparticuz/chromium` + `puppeteer-core`; el resto es HTTP plano. Cookies de sesión en Supabase para no relogear en cada invocación.

## Despliegue
- Producción: rama `main` → https://auto-despachos-silogtran.vercel.app (proyecto `auto-despachos-silogtran`, team `grachos-projects`).
- El repo es público: **nunca** commitear secretos, cookies ni HTML capturado con datos reales.

## Estado y próximos pasos
Probado contra Silogtran real: health, consulta de solicitud, `preparar` y `confirmar` (anticipo `"cero"`). Pendiente: probar anticipo `"total"` y medir tiempos frente al límite de 60 s. Siguiente bloque: **multiusuario + WhatsApp + IA** (M1–M6 en `CLAUDE.md`). Fase 2: mapear el motivo de rechazo del RNDC.
