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
7. `tipmanrndc_codigo`: opcional, default 1. Acepta código o texto parcial sin tildes: 1 general, 2 varios viajes en el día, 3 multiparada, 4 ida y regreso, 5 viaje vacío, 6 municipal o urbano, 7 varios viajes municipales. Ambiguo → `AMBIGUOUS_OPTION` con opciones.
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
- Endpoint de diagnóstico (incremento 3a, se absorberá en `preparar`): `POST /api/solicitudes/:numero/iniciar` `{item?}` — llega hasta marcar el manifiesto, informa el estado y limpia el pendiente. No graba.

## Notas verificadas de los autocompletes (HTML real, 2026-11-02)
- CAutoComplete: `POST` al `action` actual con **todos** los campos del form + `PRADO_CALLBACK_TARGET` = `PRADO_POSTBACK_TARGET` = name del campo + `PRADO_CALLBACK_PARAMETER` = `["texto",0,"__CAutoComplete_onSuggest__"]`. `%` es comodín. Respuesta: `<ul>` con un `<li title="false">` por resultado (sin ninguno = no encontrado); los **atributos del `li`** son los valores que se copian a los campos (nombre = id en minúsculas; `_idhidden` → `$IDHidden`). Comparar siempre contra el atributo, no contra el texto visible (la ruta trae dobles espacios).
- Los campos `disabled` no se envían: copiar atributos solo a campos presentes en el form. Los callbacks traen `X-PRADO-ACTIONS` (`Prado.Element.setValue`) y `X-PRADO-PAGESTATE`: aplicarlos al estado antes de la siguiente petición (`PradoPage`).
- Orden obligatorio: vehículo (postback `buscar_activo` "Seleccionar") **antes** de la ruta; al elegir la ruta se disparan los `TEventTriggeredCallback` de `ruta_codigo.change` (hoy ctl25 y ctl26; se leen del JS de la página) y se calcula el Anticipo. Sin vehículo el Anticipo queda vacío.
- Los `ctlN` pueden cambiar: ubicar triggers y botones "Adicionar" por control/pestaña, no por número fijo.
- Datos de prueba: placa `KNL058` (activa), `ZZZ999` (inexistente), ruta `SANTA MARTA%SANTA MARTA` (ID 544), banco `BANCOLOMBIA%PROPIOS` (ID 3), contenedor `WHSU545823-0` (ID 283), solicitud `0101072807` (no grabar).
- `POST /api/solicitudes/:numero/iniciar` ahora acepta `{ item?, placa?, tipoManifiesto? }`; con `placa` también llena vehículo, ruta, fechas y tipo de manifiesto (3b) y devuelve el resumen. Sigue sin grabar y siempre limpia el pendiente.
