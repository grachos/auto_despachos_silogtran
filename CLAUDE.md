# auto_despachos_silogtran

API que un LLM usa para confirmar/despachar solicitudes de transporte en **Silogtran** (TMS PRADO/PHP, sin API oficial) mediante scraping HTTP. Despliegue en **Vercel** (team `grachos-projects`, plan gratuito).

## Reglas de trabajo
- Explicaciones en **español**; código, identificadores y comentarios en **inglés**.
- Incrementos pequeños; **pedir aprobación antes de implementar cada incremento**.
- Repo **público**: secretos solo en variables de entorno. Mantener `.env.example` sin valores. Nunca commitear `.env`, cookies, HTML capturado con datos reales ni logs con credenciales.
- Fase 2 (no ahora): mapear el motivo de rechazo del RNDC.

## Base técnica
- Reutilizar el cliente de `grachos/apis_legalizacion_silogtran` (`src/silogtran.js`, `src/session.js`): login + centro de costo + reto AWS WAF con Chromium, cookie jar, cola serializada, `pradoCallback`, `formFields`.
- Centro de costo: siempre se escoge el primero disponible (sin variable de entorno).
- En Vercel: `@sparticuz/chromium` + `puppeteer-core` solo para resolver el WAF; el resto es HTTP plano.
- Cookies/sesión persistidas en **Supabase** para no relogear en cada invocación.
- Lock por solicitud (una solicitud a la vez).

## Variables de entorno
`SILOG_BASE_URL` (https://construproyec.colombiasoftware.net), `SILOG_USER`, `SILOG_PASSWORD`, `API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`.

## Flujo de despacho (pantalla `Despacho.Solicitudtransporte.Visor_105`, validado manualmente)
1. Consultar en `Despacho.Solicitudtransporte.Buscar` (campo `soltra_codigo`; con un resultado abre el formulario). Leer `soltra_contenedor` (SI/NO), origen y destino.
2. Visor: "Quitar Todos" (limpia pendientes) → postback Confirmar en la fila solicitud+item (EventTarget `ctl0$MainModule$visor$ctlN$ctl36`) → postback "Continuar confirmacion".
3. Marcar `porConfirmar$ctl0$genera_manifiesto` (postback; Orden de cargue y Remesa se marcan y bloquean solas).
4. Vehículo: CAutoComplete `vehiculo_codigo_seleccion_activo` con la placa → ID en `$IDHidden` → botón `buscar_activo` ("Seleccionar", postback). Silogtran llena `trailer_codigo`, `tercero_codigo_conductor`, clase, carrocería, tipo operación. Sin resultados → `VEHICLE_NOT_ACTIVE`; varios → `AMBIGUOUS_OPTION`.
5. Ruta: CAutoComplete `ruta_codigo` con `ORIGEN%DESTINO`; elegir coincidencia exacta `ORIGEN - DESTINO`. Al seleccionar se calcula el Anticipo. Sin resultados → `ROUTE_NOT_FOUND`.
6. Fechas (America/Bogota): `fecha_salida`/`hora_salida` = ahora (`yyyy-MM-dd` / `HH:mm:ss`); `fecha_limiteentrega`/`hora_limiteentrega` = salida + 5 días; `fecha_limitecumplido` = limiteentrega + 5 días; `soltra_volumengalontanqueado` = 0.
7. `tipmanrndc_codigo`: opcional. **Default por regla de negocio**: si Ciudad Origen = Ciudad Destino del ítem (sin mayúsculas, tildes ni espacios sobrantes) → 6 (VIAJE MUNICIPAL O URBANO); si son distintas → 1 (MANIFIESTO GENERAL). Un `tipoManifiesto` explícito siempre tiene prioridad. Acepta código o texto parcial sin tildes: 1 general, 2 varios viajes en el día, 3 multiparada, 4 ida y regreso, 5 viaje vacío, 6 municipal o urbano, 7 varios viajes municipales. Ambiguo → `AMBIGUOUS_OPTION` con opciones.
8. Anticipo: `"total"` (valor calculado por Silogtran) o `"cero"` (Anticipo=0 y disparar callback `ctl32`). Si total, pestaña Pago Anticipos: `tipegr_codigo`=TRANSFERENCIA POR ARCHIVO, `ValorPago`=anticipo, `banco_codigo` autocomplete `BANCOLOMBIA%PROPIOS` (ID 3) → Adicionar.
9. Pestaña Observaciones Documentos: `itemobservaciones_ordenCompra`, `itemobservaciones_Ordencargue`, `itemobservaciones_Remesa` (default "NA"; Remesa obligatoria, oculta a la derecha); `remesa_fechacompromiso`/`horacompromiso` (cita cargue) y `remesa_citadescarguefecha`/`hora` (cita descargue) **obligatorias**, vienen del usuario; tiempos pactados 2 h 0 min en cargue y descargue → Adicionar.
10. Si `soltra_contenedor`=SI: pestaña Contenedores, `itemremesacontenedor_ContenedorCodigo` (autocomplete por número) + `itemremesacontenedor_IteremconNumerobl` obligatorios → Adicionar. Faltan → `CONTAINER_REQUIRED`; no existe → `CONTAINER_NOT_FOUND`. Si NO, vacía. Pestañas Equipos y Auxiliar no se llenan.
11. Grabar = postback `ctl0$MainModule$Generar` (incluye `grabar_uuid`). Éxito: "El registro ha sido guardado!" + tabla "Documentos Generados" (Orden de Cargue, Remesa, Manifiesto, Transferencia). Otros mensajes (ej. "Respuesta Plataforma Monitor ... 500") → `warnings`.
12. Estado RNDC: `GET index.php?page=Despacho.Manifiesto_003.Home_111&manifiesto_codigo=N` → texto de `#ctl0_MainModule_manifiesto_numero` con formato `consecutivo - radicado / Fecha Hora fecha`. Radicado presente = migró; vacío = "Sin migrar al Ministerio".

## Contrato de la API
Consumidor: un LLM. Errores: `{ ok:false, code:"FIXED_CODE", message:"<español>" }`. Auth: header `x-api-key`.

- `POST /api/solicitudes/:numero/preparar`
  Body: `{ placa, citaCargue{fecha,hora}, citaDescargue{fecha,hora}, tipoManifiesto?, ordenCompra?, observacionOrdenCargue?, observacionRemesa?, contenedor?, bl? }`
  Llena todo **sin grabar**; devuelve resumen (vehículo, trailer, conductor, ruta, fechas, anticipo sugerido, requiereContenedor) + `token`.
- `POST /api/solicitudes/:numero/confirmar`
  Body: `{ token, anticipo: "total"|"cero" }`. Rehace el llenado, verifica que el anticipo no cambió (`ANTICIPO_CHANGED`), graba y responde:
  `{ ok, status:"DISPATCHED"|"DISPATCHED_NOT_MIGRATED", message:"Se despachó a satisfacción. Remesa X, Manifiesto Y. Radicado Ministerio Z | Sin migrar al Ministerio.", documents{ordenCargue,remesa,manifiesto,transferencia}, rndc{migrated,radicado,fechaHora}, warnings[] }`

Códigos de error conocidos: `VEHICLE_NOT_ACTIVE`, `AMBIGUOUS_OPTION`, `ROUTE_NOT_FOUND`, `CONTAINER_REQUIRED`, `CONTAINER_NOT_FOUND`, `ANTICIPO_CHANGED` (+ los de infraestructura que se definan: auth, login, WAF, lock).

## Visión multiusuario (roadmap, aún no implementado)
- La app tendrá usuarios independientes de Silogtran. En la web (Vercel) cada persona registra su usuario y contraseña de Silog; con eso se le entrega un **código de un solo uso, con expiración**, para vincular su número de **WhatsApp Business API (Meta)**.
- Los despachos se lanzan desde WhatsApp con una IA conversacional que pregunta los valores en lenguaje natural; también puede recibir **una tabla** con varios despachos, interpretarla, crearlos y devolver los resultados.
- Credenciales Silog por usuario: guardadas en Supabase **cifradas** (AES-GCM, clave maestra solo en variable de entorno), descifradas solo en memoria al abrir la sesión, nunca en logs ni respuestas. Viajan solo por HTTPS.
- Sesión Silogtran por usuario (`silog_session.id` = id de usuario; hoy `default` = "usuario cero" con `SILOG_USER`/`SILOG_PASSWORD`).
- Token de `preparar` ligado al usuario. Lock por usuario+solicitud guardado en Supabase (Vercel no comparte memoria).
- Auth: token por usuario; `API_KEY` queda como clave de servicio entre el bot de WhatsApp y esta API.
- Lotes: despachos largos (Vercel gratis corta a 60 s) → trabajos asíncronos en cola y resultado por WhatsApp. `preparar`/`confirmar` deben ser funciones independientes de la petición HTTP.
- La **confirmación humana** (resumen + anticipo) se mantiene siempre antes de grabar, también en lotes.

## Notas verificadas del visor (HTML real, 2026-11-02)
- `GET index.php?page=Despacho.Solicitudtransporte.Visor_105` abre directo, sin Hash. Siempre postear al `action` de la última respuesta.
- El visor **no filtra por número de solicitud**: se filtra por `soltra_fechacreacion` (leída del formulario de la solicitud) y se busca la fila por columnas `Solicitud` + `Item`. Paginación ("Siguiente >") aún sin implementar.
- Confirmar es un `TLinkButton` (`ctl0$MainModule$visor$ctlN$ctl36`, N = índice de fila); tomar el EventTarget del JS de la página.
- "Quitar Todos" (`limpiar`) y "Continuar confirmacion" (`confirmar`) son `submit` simples; "Quitar Todos" solo existe si hay pendientes. El pendiente vive en la **sesión** de Silogtran → limpiar antes y después de cada intento.
- "Continuar confirmacion" redirige a `Confirmar_111&Hash=<token generado por el servidor>`; validar la pantalla por la existencia de `#ctl0_MainModule_porConfirmar_ctl0_genera_manifiesto`.
- Al marcar `genera_manifiesto` (autopostback) `genera_orden` y `genera_remesa` quedan marcados y deshabilitados, y aparece "Información Despacho".

## Notas verificadas de los autocompletes (HTML real, 2026-11-02)
- CAutoComplete: `POST` al `action` actual con **todos** los campos del form + `PRADO_CALLBACK_TARGET` = `PRADO_POSTBACK_TARGET` = name del campo + `PRADO_CALLBACK_PARAMETER` = `["texto",0,"__CAutoComplete_onSuggest__"]`. `%` es comodín. Respuesta: `<ul>` con un `<li title="false">` por resultado (sin ninguno = no encontrado); los **atributos del `li`** son los valores que se copian a los campos (nombre = id en minúsculas; `_idhidden` → `$IDHidden`). Comparar siempre contra el atributo, no contra el texto visible (la ruta trae dobles espacios).
- Los campos `disabled` no se envían: copiar atributos solo a campos presentes en el form. Los callbacks traen `X-PRADO-ACTIONS` (`Prado.Element.setValue`) y `X-PRADO-PAGESTATE`: aplicarlos al estado antes de la siguiente petición (`PradoPage`).
- Orden obligatorio: vehículo (postback `buscar_activo` "Seleccionar") **antes** de la ruta; al elegir la ruta se disparan los `TEventTriggeredCallback` de `ruta_codigo.change` (hoy ctl25 y ctl26; se leen del JS de la página) y se calcula el Anticipo. Sin vehículo el Anticipo queda vacío.
- Los `ctlN` pueden cambiar: ubicar triggers y botones "Adicionar" por control/pestaña, no por número fijo.
- Datos de prueba: placa `KNL058` (activa), `ZZZ999` (inexistente), ruta `SANTA MARTA%SANTA MARTA` (ID 544), banco `BANCOLOMBIA%PROPIOS` (ID 3), contenedor `WHSU545823-0` (ID 283), solicitud `0101072807` (no grabar).

## Notas verificadas de las pestañas (HTML real, 2026-11-02)
- "Adicionar" son `TButton` con `ValidationGroup` propio (`Requeridosanticipo`, `Requeridosobservaciones`, `Requeridosdetallecontenedor`); se resuelven por grupo en el JS de la página (los `ctlN` cambian). Postback completo: `PRADO_POSTBACK_TARGET` = botón y botón = "Adicionar".
- La validación es solo del lado cliente: un Adicionar incompleto el servidor lo **ignora sin mensaje**. Siempre verificar la fila en `#ctl0_MainModule_ItemsObservaciones` (`Solicitud` = `<numero>-<item>`) y `#ctl0_MainModule_ItemsRemesacontenedor` (`Contenedor` + `Numero BL`).
- Observaciones: ordenCompra/Ordencargue/Remesa ("NA" por defecto), citas de cargue y descargue (fecha `yyyy-MM-dd`, hora `HH:mm:ss`) y tiempos pactados 2 h 0 min. Sin callbacks.
- Contenedor: autocomplete `itemremesacontenedor_ContenedorCodigo` copia `contenedor_numero`, `naviera_codigo`, `tipcon_codigo`, `contenedor_tara` y `lugar_codigo`; este último puede venir **vacío** y es obligatorio → buscarlo con el autocomplete `lugar_codigo` (`%`, ~4 resultados) comparando por nombre con el sitio de entrega de la solicitud. BL obligatorio.
- Seleccionar el vehículo después de la ruta conserva la ruta y recalcula el Anticipo; el orden recomendado sigue siendo vehículo → ruta. El anticipo se relee al final de `preparar`.
- **`POST /api/solicitudes/:numero/preparar`** (3c) reemplaza al endpoint de diagnóstico `iniciar`. Requiere `TOKEN_SECRET` (token HMAC con los datos del preparar, vence a los 15 min). Nunca graba y siempre limpia el pendiente.

## Notas verificadas de anticipo, grabar y RNDC (HTML real, 2026-11-02)
- Pago Anticipos (`Requeridosanticipo`): `tipegr_codigo` = TRANSFERENCIA POR ARCHIVO (valor 5; callback blur), `ValorPago` sin separador de miles, `banco_codigo` = BANCOLOMBIA PROPIOS (ID 3; callback change). Verificar fila en `#ctl0_MainModule_ItemsPago` (`Tipo Pago` + `Valor` = anticipo). Anticipo "cero" → `Anticipo`=0 + callback change, sin fila. Anticipo 0 calculado → no hay pago.
- Grabar = postback `ctl0$MainModule$Generar` ("Grabar"), tarda 10–18 s (timeout de 50 s). Éxito = `#ctl0_MainModule_mensaje` contiene "El registro ha sido guardado"; el resto del texto va a `warnings`. "Documentos Generados": enlaces numéricos clasificados por `page=` del href (`Despacho.Ordencargue`, `Despacho.Remesa`, `Despacho.Manifiesto`, `Financiero.Transferencia`). **Pendiente**: ids exactos del contenedor del mensaje y de la tabla (capturar en el próximo despacho real).
- RNDC: `GET index.php?page=Despacho.Manifiesto_003.Home_111&manifiesto_codigo=N` → `#ctl0_MainModule_manifiesto_numero`: `"217880 - "` = sin migrar; `"217879 - 126863033 … Fecha Hora 2026-11-02 / 14:16:14"` = migrado. Botones de reenvío (`EnviarMinisterio`, etc.) y `#ctl0_MainModule_mensajeManifiestoRNDC`: fase 2.

## `confirmar` (3d) — protecciones
- Token de un solo uso (`jti`): tabla `silog_confirmaciones` (`PROCESSING` → `DONE` | `FAILED` | `UNKNOWN`). Mismo token ya `DONE` → devuelve el resultado guardado con `repeated: true` (no vuelve a grabar). `FAILED` (no se grabó) puede reintentarse; `UNKNOWN` (el guardado pudo haber ocurrido) exige verificar a mano y un token nuevo. Una fila `PROCESSING` de más de 3 min pasa a `UNKNOWN`.
- Lock por solicitud: índice único parcial sobre `numero` donde `status='PROCESSING'` → `SOLICITUD_LOCKED` (409).
- `ANTICIPO_CHANGED` si el anticipo recalculado difiere del token. El estado `DONE` se guarda **antes** de consultar el RNDC. Si el RNDC no se puede leer: `DISPATCHED` con advertencia.
- Errores: `SAVE_REJECTED` (Silogtran respondió sin guardar), `SAVE_RESULT_UNKNOWN`, `CONFIRMATION_IN_PROGRESS`, `CONFIRMATION_UNKNOWN`, `TOKEN_INVALID`, `TOKEN_EXPIRED`, `BANK_NOT_FOUND`, `ANTICIPO_PAGO_NOT_ADDED`.

## Estado actual (cierre 2026-11-03)
- **Hecho y probado contra Silogtran real**: `GET /api/health`, `GET /api/solicitudes/:numero`, `POST .../preparar`, `POST .../confirmar` (primer despacho real con anticipo `"cero"` OK: orden de cargue, remesa y manifiesto generados; RNDC "sin migrar").
- **Pendiente de probar**: anticipo `"total"` (pago TRANSFERENCIA POR ARCHIVO) con un despacho real de bajo valor; tiempos reales de `confirmar` frente al límite de 60 s de Vercel; ids exactos del mensaje y de "Documentos Generados" tras grabar (hoy se leen por `#ctl0_MainModule_mensaje` y por `href`).
- **Despliegue**: producción sale de la rama `main` (Vercel → Branch Tracking). Se trabaja en `claude/intelligent-shannon-nzb7k6` y se lleva a `main` cuando está probado. Supabase: proyecto `nexczcdmwysulvvxldlf` (tablas `silog_session`, `silog_confirmaciones`; migraciones en `supabase/migrations/`).
- Variables de entorno en Vercel (Production): `SILOG_BASE_URL`, `SILOG_USER`, `SILOG_PASSWORD`, `API_KEY`, `TOKEN_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` y, desde M1, `ENCRYPTION_KEY` (64 hex), `ADMIN_KEY` y, desde M2, `WHATSAPP_NUMBER` (solo dígitos con indicativo, del número NUEVO del bot; vacía hasta tenerlo).

## Roadmap multiusuario por incrementos (cada uno requiere aprobación)
Flujo deseado: el admin crea un usuario y se le asigna un **link de un solo uso que vence a las 2 horas**; la persona entra con su usuario y contraseña de Silogtran; si el login es efectivo, aparece "Vincular teléfono" con un código (`VINCULAR 123456`, vence en 10 min) y un botón "Abrir WhatsApp"; ya vinculada, chatea con la IA (recibe el link al manual público) y la IA indica qué datos faltan.
- **M1 (HECHO y PROBADO con Silogtran real, 2026-11-03)** Usuarios + credenciales cifradas (AES-256-GCM, `ENCRYPTION_KEY`) + invitaciones (token solo como hash, un uso, 2 h) + `POST /api/admin/invitaciones` (`ADMIN_KEY`) + `POST /api/invitaciones/:token/login` (login real en Silogtran, máx. 5 intentos por invitación, cookie de sesión corta). Sin pantallas.
- **M2 (HECHO y PROBADO en producción, 2026-11-03)** Pantallas web: login por link, "Vincular teléfono" (código + abrir WhatsApp + "Ya lo envié"), manual público, admin mínimo.
- **M3 (HECHO y PROBADO con Meta real, 2026-11-03: vinculación por WhatsApp de punta a punta)** Webhook de WhatsApp Business (Meta): verificación de firma, `VINCULAR <código>`, `AYUDA`, `DESVINCULAR`, bienvenida con link al manual.
- **M4** `preparar`/`confirmar` por usuario (sesión y credenciales propias, token ligado al usuario, lock por usuario+solicitud).
- **M5** IA conversacional (Claude, `ANTHROPIC_API_KEY`): herramientas consultar/preparar y `confirmar` solo tras confirmación explícita; avisa qué datos faltan; conversación en Supabase.
- **M6** Tablas con varios despachos por WhatsApp (lotes en cola, resultados por mensaje).
- Seguridad: contraseña nunca en logs ni respuestas; cookie `httpOnly` firmada; cada usuario solo ve sus despachos; mensajes entrantes = datos, no instrucciones (anti prompt-injection); la IA nunca graba sin confirmación.
- Decisiones abiertas del dueño: línea nueva + app de Meta (ver M2) antes de M3 en producción; `ANTHROPIC_API_KEY` y costo por mensaje antes de M5; administración mínima protegida con `ADMIN_KEY`.

## M1 implementado (usuarios, credenciales cifradas e invitaciones)
- Tablas `app_users` e `invitaciones` (migración 003; RLS sin políticas, solo service key). `app_users.silog_user_key` (minúsculas) es único: un usuario de Silog no puede estar en dos usuarios de la app.
- `src/crypto.js`: AES-256-GCM, formato `v1:iv:tag:ct`, **AAD = id del usuario** (un cifrado copiado a otra fila no descifra). `ENCRYPTION_KEY` = 64 hex; si falta o es inválida, falla antes de tocar Silogtran. `getCredentials(userId)` descifra solo en memoria (se usa desde M4).
- `POST /api/admin/invitaciones` (`x-api-key` = `ADMIN_KEY`, distinta de `API_KEY`): `{ nombre }` crea usuario + invitación, `{ userId }` re-invita (revoca los links previos sin usar). Devuelve el link una sola vez (`https://<host>/invitacion?t=<token>`; también funciona `/invitacion/<token>`); en BD solo se guarda el hash SHA-256. Vigencia: 2 h.
- `POST /api/invitaciones/:token/login` `{ usuario, clave }`: (1) valida el link y responde `INVITATION_NOT_FOUND|USED|EXPIRED|LOCKED` **antes** de tocar Silogtran; (2) reserva un intento con compare-and-set atómico (máx. 5); (3) login real en Silogtran con un cliente **nuevo** (no toca la sesión del usuario cero; solo reutiliza cookies `aws-waf*` para evitar Chromium); (4) credenciales malas → 401 `LOGIN_REJECTED` con `intentosRestantes`; error de infraestructura (WAF, red) → **devuelve el intento**; (5) éxito → consume el link de forma atómica, guarda la contraseña cifrada y las cookies bajo el id del usuario y emite la cookie de sesión (`sid`, HttpOnly, Secure, SameSite=Lax, 30 min). `SILOG_USER_ALREADY_LINKED` (409) si ese usuario de Silog ya está vinculado a otra persona.
- `typ` en los tokens firmados: `preparar` vs `session` no son intercambiables (`confirmar` rechaza cualquier token que no sea `preparar`). `src/http/session.js`: `setSessionCookie` / `readSession`.
- Errores nuevos: `CONFIG_INVALID` (variable presente pero con formato inválido), `INVITATION_*`, `LOGIN_REJECTED`, `LOGIN_NOT_SUPPORTED` (contraseña por cambiar o 2FA), `SILOG_USER_ALREADY_LINKED`, `USER_NOT_FOUND`, `USER_NOT_ACTIVE`, `DECRYPT_FAILED`.

## M2 implementado (pantallas web y vinculación)
- Páginas estáticas en `public/` (estilo claro, sin framework, JS en archivos externos): `/invitacion/<token>` (login con usuario/clave de Silog), `/vincular` (código `VINCULAR 123456`, cuenta regresiva de 10 min, "Abrir WhatsApp", "Ya lo envié", "Generar otro código"; consulta el estado cada 4 s y pasa sola a "vinculado"), `/manual` (manual público, redactado desde el contrato: **revisar el contenido**), `/admin` (pide `ADMIN_KEY`, no la guarda; crea usuario o re-invita con `userId`), `/` (portada).
- `vercel.json`: `cleanUrls`, rewrite `/invitacion/:token`, y cabeceras en las páginas (no en `/api`): CSP estricta (`script-src 'self'`, sin inline), `Referrer-Policy: no-referrer` (el token va en la URL), `X-Frame-Options: DENY`, `nosniff`, y `no-store` en invitacion/vincular/admin. Por eso no hay `<script>` ni `style=` inline.
- `POST /api/vinculacion/codigo` (cookie `sid`): código de 6 dígitos, vigencia 10 min, revoca los anteriores sin usar, máx. 5 por hora (`CODE_RATE_LIMIT`, 429). En BD solo se guarda `HMAC-SHA256(TOKEN_SECRET, "vinculacion:<codigo>")`. Devuelve `mensaje`, `expiraEn`, `numeroWhatsapp` y `whatsappUrl` (wa.me; nulo si falta `WHATSAPP_NUMBER`).
- `GET /api/vinculacion/estado` (cookie `sid`): `{ vinculado, desde, telefono: "••••6938", numeroWhatsapp }`. `requireSession` exige cookie válida y usuario `ACTIVE` (`SESSION_REQUIRED`, 401).
- Tablas `codigos_vinculacion` y `vinculos_whatsapp` (migración 004; RLS sin políticas). `vinculos_whatsapp` la llena el webhook (M3): una fila por usuario, teléfono único.
- Probado: pantallas en Chromium con API simulada (errores, éxito, redirección, sesión vencida, límite de códigos, sin violaciones de CSP).
- **Decisión (2026-11-03)**: el bot de Despachos usa un **número propio, distinto del de SICE Query** (+57 322 718 6938 es de SICE Query: no usarlo). Así hay un solo webhook por número, sin enrutador y sin choque de palabras clave (`VINCULAR`, `AYUDA`, `DESVINCULAR` se mantienen). App de Meta propia (App Secret, token y webhook propios). Pendiente: comprar la línea; mientras tanto el M3 se desarrolla y prueba con el número de pruebas gratuito de Meta.

## M3 implementado (webhook de WhatsApp)
- `api/whatsapp/webhook.js`: **GET** = verificación de Meta (`hub.mode=subscribe`, `hub.verify_token` contra `WHATSAPP_VERIFY_TOKEN` en tiempo constante, responde `hub.challenge` en texto plano). **POST** = mensajes: lee el cuerpo **crudo** (`bodyParser: false`), verifica `X-Hub-Signature-256` = HMAC-SHA256(`WHATSAPP_APP_SECRET`, cuerpo) antes de hacer nada (401 `SIGNATURE_INVALID`), ignora mensajes de otro `phone_number_id`, y responde 200 (o 500 si alguno falló, para que Meta reintente).
- `src/whatsapp/handler.js`: dedupe por id de mensaje (`whatsapp_mensajes`; si el procesamiento falla se des-marca para el reintento). `VINCULAR <6 dígitos>` (también `VINCULAR DESPACHO <6 dígitos>`): consume el código de forma atómica, **la última vinculación gana** (un teléfono ↔ una cuenta), bienvenida con link al manual; máx. 5 códigos fallidos por teléfono/hora (`whatsapp_intentos`) → bloqueo sin consumir el código. `AYUDA`, `DESVINCULAR`. Texto de un usuario vinculado: respuesta provisional hasta el M5. Usuario no vinculado: instrucciones para vincular + manual. Las respuestas nunca repiten texto del usuario; los logs nunca incluyen texto ni códigos.
- `src/whatsapp/api.js`: envío por Cloud API (`WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`; versión Graph en `WHATSAPP_API_VERSION`, por defecto v23.0). `PUBLIC_BASE_URL` opcional para los links (por defecto el dominio de producción).
- Migración 005 (`whatsapp_mensajes`, `whatsapp_intentos`). Página pública `/privacidad` (URL de política exigida por Meta para pasar la app a *Live*; **revisar el texto y añadir un contacto**).
- Variables: `WHATSAPP_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_PHONE_ID`, `WHATSAPP_NUMBER` (bot: 573246407597).
- Riesgo conocido: el cuerpo crudo depende de que el runtime de Vercel no lo haya consumido; si la primera firma real falla con cuerpo correcto, revisar logs (`[whatsapp] invalid signature`).

## Pendientes tras M1-M3
- Página `/eliminacion-de-datos` y paso de la app de Meta a modo *Live* (hoy en desarrollo: solo reciben mensajes los números con rol/prueba). Revisar el texto de `/privacidad` y añadir un contacto.
- Siguiente incremento: **M4** (preparar/confirmar con la sesión y credenciales de cada usuario).

## Panel de administración (`/admin`)
- Acceso: `POST /api/admin/login { key }` canjea `ADMIN_KEY` por una cookie `adm` (HttpOnly, Secure, SameSite=Strict, Path=/api/admin, 8 h, token `typ:"admin"`); la clave no queda en el navegador. 10 fallos por IP en 15 min → bloqueo (`admin_intentos`). Los endpoints admin aceptan la cookie o `ADMIN_KEY` en `x-api-key`; las escrituras con cookie exigen `Origin` igual al host (`FORBIDDEN_ORIGIN`).
- Endpoints: `GET /api/admin/usuarios` (estado, WhatsApp vinculado/desvinculado, teléfono enmascarado, nº de despachos, último despacho), `GET /api/admin/reporte?desde&hasta&usuario(id|cero)&estado(DONE|FAILED|UNKNOWN)[&format=csv]` (una fila por intento + KPIs; por defecto últimos 30 días; máx. 1000 filas; CSV con neutralización de fórmulas), `POST /api/admin/rndc-actualizar` (relee en Silogtran el estado del Ministerio de hasta 10 manifiestos sin radicado de los últimos 14 días y guarda radicado y fecha/hora), `POST /api/admin/invitaciones`, `POST /api/admin/logout`.
- Pestañas: Resumen (éxito %, tiempo total promedio/p50/p90, preparar vs grabar, migrados al Ministerio), Usuarios, Despachos (filtros + exportar CSV + "Actualizar radicados"), Invitaciones. Todo dato del servidor se pinta con `textContent` (probado con una carga XSS).
- Métricas (migración 006, columnas nuevas en `silog_confirmaciones`): `prepare_ms` (llenar el formulario), `save_ms` (Grabar), `total_ms` (reclamo → guardado; excluye la lectura del RNDC), documentos, `radicado`, `rndc_migrated`, `rndc_fecha_hora`, `placa`, `anticipo_modo/valor`, `error_code`, `user_id` (se llena desde M4; hoy `null` = "API (usuario cero)"). Los tiempos miden **la automatización**, no cuánto tarda el Ministerio en migrar. El despacho previo a la 006 se rellenó con `total_ms` aproximado (incluye la lectura del RNDC).
