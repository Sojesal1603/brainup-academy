# PROGRESS — BrainUp Academy

Registro vivo. Cada fila se actualiza en el mismo commit que cierra su paso.
Estados: `pendiente`, `en curso`, `bloqueado`, `hecho`.

| Paso | Estado | Commit | Evidencia | Pendiente |
| --- | --- | --- | --- | --- |
| Docs (ENCARGO/PLAN/PROGRESS) | hecho | `e170cf3`, `0d0640b` | Los tres archivos existen y se commitean solos antes de seguir. | Sustituir `docs/ENCARGO.md` si el autor pega el texto literal. |
| 1. Identidad única Supabase | hecho | `d424a11`, `26518c3`, `2a2df35`, este commit | 1a–1d ya verificados. 1e aplicada el 2026-11-13T19:05:00Z sobre `aws-0-eu-north-1.pooler.supabase.com:5432` (no local): `UserProfile` = `16bb4958-…`, 471 filas movidas con `ON UPDATE CASCADE`, 0 restos de `user_default`, 24/24 tablas cuadradas. Ensayo previo en Postgres 17 local: 26/26 recuentos idénticos y migración de 471 filas con 0 restos. Dump nuevo `data/backups/brainup-pre-1e-20261113.dump` (513.383 B, SHA-256 `60ed96ef…`), legible con `pg_restore -l` (591 entradas). Build 0, salud 200, `/` → `/login`, `/login` 200, APIs 401. Cuenta de prueba con 0 filas. | Nada de 1e. Quedan los `@default("user_default")` transitorios (1f). |
| 2. Esquema expand (PlanState, PlanConstraint, TutorSessionOutcome) | hecho | este commit | Tres tablas creadas con `@@unique([userId, day])`, índices y FKs `ON UPDATE CASCADE`; `TutorSessionOutcome.planId` con `SET NULL`. `20261113191500_planificador_expand` aplicada; `20261112120000_user_profile_timezone` aplicada (faltaba en producción); `ebau_focus` marcada como aplicada sin reejecutarla. `prisma validate` y `tsc --noEmit` limpios; `migrate status` al día. | Nada de esquema; los defaults históricos siguen (1f). |
| 3. Motor puro | hecho | este commit | `src/lib/planner/engine.ts`: `capacityFor`, `score`, `pickBlocks` e `interleave`; sin Prisma, sin IA y sin `Date.now`. Capacidad al 70 %, energía 0.5/1/1.2, mínimo 10–15 min, 3–5 bloques, máximo 2 por materia y examen a 2 días por delante. `tsc` y `eslint` limpios. | Nada. |
| 4. Tests del motor | hecho | este commit | `scripts/verify-planificador.js`: determina con el mismo contexto y con el orden invertido, capacidad 70 %, energía 0.5/1/1.2, mínimo, 3–5 bloques, máximo 2 por materia, examen a 2 días e intercalado. 11 comprobaciones, exit 0. | Nada. |
| 5. Orquestador `ensureTodayPlan` | hecho | este commit | Advisory lock de PostgreSQL `hashtextextended(userId:día)` + doble comprobación dentro de la transacción + `PlanState` idempotente. Solo se borran bloques pendientes generados por el plan (`plan`/`reprogramada`/`recuperacion`); `en_curso`, completados, abandonados y `micro` se conservan. Ensayo contra copia local: dos aperturas simultáneas → 1 `PlanState`, repetir no duplica y los bloques en curso/completados siguen intactos. Corregido el `this` de `db().$transaction`. | Nada. |
| 6. `invalidatePlan` y disparadores | hecho | este commit | `invalidatePlan(userId, reason)` guarda `status=invalidated`, fecha, motivo y versión en `PlanState` (columna nueva `invalidationReason`). Disparadores conectados: completar/abandonar/reabrir bloque y sesión, crear/editar/borrar/completar examen, avance de clase, recalcular y sincronización de Moodle con cambios. La siguiente apertura reconstruye una sola vez y conserva lo empezado. Ensayo local: motivo conservado, versión +1, un solo `PlanState`. `tsc`/`eslint` limpios. | Los disparadores de UI no se han recorrido uno a uno en navegador; sí compilan y comparten la misma función. |
| 7. Entradas reales (`loadInputs`/`buildCandidates`/`toRow`) | hecho | este commit | `loadPlanningContext` usa FSRS/ReviewCard/ErrorLog/MoodleTask/Exam/ClassPeriod y ahora agrega `FocusSession` (`focusedSeconds`) y `SrsReview` (`minutesSpent`) por unidad. `calibrateUnitEstimate` solo ajusta con ≥3 sesiones, ≥45 min y unidad avanzada; hasta entonces `source='estimado'`. La UI muestra «X h · estimado» o «X h · ajustado (N)». Producción: 102 unidades, 0 FocusSession y 0 SrsReview → todas «estimado». `verify-sesiones.js`: 115 comprobaciones en verde. `dayPlan.ts` no importa IA. | La calibración real se verá cuando haya sesiones medidas; los tests cubren el cálculo, no datos de producción (no existen todavía). |
| 8. UX del Cuartel | hecho | este commit | Un único «Ahora» (el bloque pausado o el primero) con Empezar/material; el resto en un `<details>` «Después» reordenable por arrastre limitado (solo pendientes, no toca lo empezado). Selector de energía que escribe `PlanState.energy` y reconstruye (0.5/1/1.2); microacción de 2 min. Aviso Web Push: VAPID, tabla `PushSubscription` (RLS activo, 0 privilegios anon), suscripción desde el navegador, cron `/api/push/send-due` protegido y `push`/`notificationclick` en `sw.js`. Prueba real contra endpoint HTTPS local: `due=1`, `sent=1`, 361 B `aes128gcm`, `lastNotifiedDay=2026-11-13`; perfil y suscripción restaurados. Plan real: 1 sesión de 50 min en 55 disponibles, `estimado`; sin IA. | El envío al navegador real requiere instalar la PWA y dar permiso (no hay sesión de navegador en este entorno); el camino de servidor está probado. |
| 0. Claves de IA por usuario (pasos 0–3) | hecho | este commit | Política única en `credentials.ts` (propia → `PLATFORM_AI_USER_IDS` → 402 `ai_key_required`) y motor sin claves de entorno. `UserAiKey` guarda la clave cifrada con AES-256-GCM (`lib/security/vault.ts`, formato `v1.iv.tag.ct`, AAD = `userId:provider`, IV aleatorio; las filas antiguas con AAD = userId se migran al leerlas). Ajustes permite guardar/comprobar/borrar con Zod, límite de 5 intentos/10 min en `AiKeyAttempt` (tabla con RLS, no memoria), estados `sin_comprobar|valida|invalida|sin_cuota` y solo los últimos 4. Aviso neutral: Google exige ser mayor de 18 años para crear claves de API de Gemini. `/api/ia/mi-clave` y la tarjeta de Ajustes muestran el estado con la sesión, sin `service_role`. `verify-vault` 11/11, `verify-user-ai-key` 10/10 (AAD por cuenta y proveedor, migración de filas antiguas, `AiKeyAttempt` con RLS y 0 grants anon/authenticated), `verify-ai-keys` 9/9, motor en verde, build/tsc/lint 0. | Nada de cifrado; el flujo de pegar/borrar con la cuenta de prueba requiere sesión real (no hay contraseña en este entorno). |
| 0b. Catedrático con clave propia y claves multiproveedor | hecho | este commit | **Causa del «Sin IA ahora mismo»**: `ensureAiAccess` activaba el ámbito con `AsyncLocalStorage.enterWith` dentro de su propia función; al volver a la ruta el contexto ya no lo tenía, `hasAiProviderAsync()` veía cero proveedores y el chat caía al respaldo local aunque la clave fuera válida (reproducido con Node: el llamante lee `undefined`). Ahora la puerta devuelve las credenciales y **cada ruta las activa en su marco** (`activateAiCredentials`), con test de regresión y guarda que exige la llamada en las 9 rutas de IA. La cabecera del catedrático ya no anuncia Groq: sale del primer motor real de la cadena. Quien tiene clave propia no se completa con claves de plataforma de otros proveedores (test con Gemini/Groq/OpenRouter/NVIDIA de plataforma y una sola clave propia). «Mi clave de IA» gestiona **los cuatro proveedores**: formato por proveedor (`google` → `gemini`), comprobación real (generación con el primer modelo en Gemini/Groq; `/api/v1/key` en OpenRouter; `/v1/models` en NVIDIA), cifrado AES-256-GCM con AAD `userId:provider`, guardar/comprobar/cambiar/borrar por proveedor y estado por chips. El respaldo local nombra el proveedor del alumno cuando la clave propia falla. `verify:ai-keys` 12/12, `verify:user-ai-key` 15/15, `verify:ai` y `verify:vault` 11/11 en verde; `tsc` y `eslint` 0. | Pegar/borrar las claves nuevas en el navegador requiere una sesión real (no hay contraseña en este entorno): queda como prueba manual. NVIDIA sigue con la cadena de chat vacía porque su cuenta responde 404 a los modelos. |
| 9. Restricciones y contexto del tutor | hecho | este commit | Restricciones `max_minutes`/`avoid_subject`/`only_subject` con `responseSchema` de Gemini y Zod; la propuesta se enseña y solo se guarda tras confirmar. El plan de hoy filtra candidatos, aplica el techo de minutos y respeta las restricciones al inyectar repasos. El catedrático recibe restricciones, errores, exámenes y método del profesor; el saludo se redacta por reglas sin IA. `open_document` se ejecuta en servidor con el userId de la sesión, sin SSE, y las citas usan `?doc=note:ID` + `NoteSplitPanel`. `verify-constraints` 8/8. | El flujo completo de confirmar restricciones en el navegador no se ha recorrido con sesión real; los contratos, el filtrado y la integración están compilados y probados por unidad. |
| 10a. Adjuntos en el catedrático | hecho | este commit | `PUT/GET/DELETE /api/tutor/attachments` exigen sesión y guardan/leen en `data/uploads/{userId}/`; `readUpload`, `readUploadBytes`, `readUploadText` y `deleteUpload` reciben el userId, así que un id ajeno da 404. Tipo real por magic bytes (PNG/JPG/WEBP/GIF/PDF/ZIP/texto UTF-8), tope de 300 páginas de PDF, 512 MB por archivo y 15 MB para enviar bytes al modelo. El prompt declara los documentos como DATO y el modelo no tiene herramientas. `AiAttachment.userId` se escribe con la sesión. `verify-attachments` 11/11 (imagen, PDF, extensión falsa, acceso cruzado, tamaño y 301 páginas). | `localPath` sigue en disco local: en serverless no persiste. Deuda anotada: mover a Supabase Storage con bucket privado y rutas `{userId}/…` antes de usar serverless. La visión real depende del modelo que responda; si no puede ver, el aviso es explícito. |
| 10. Cierre de sesión, corrector, foto y banco | hecho | este commit | `sessionClose.ts` escribe en una transacción el `TutorSessionOutcome` (clave `sesion:<agente>:<día>`), las fichas de `ErrorLog` y las `ReviewCard` con `frontHash`, y después invalida el plan; el índice único `[userId, sessionKey]` impide duplicados al repetir. Migración `20261114210000_session_close` aplicada (2026-11-14T22:28:21Z; columnas e índices comprobados). Corrector con rúbrica Zod, dos pasadas y mediana por bloque, sin rellenar notas que el modelo no da. Foto manuscrita: `/api/examinador/foto` la transcribe con visión y devuelve confianza; el envío corrige **la transcripción** y avisa si no se ha podido leer. Banco de 4 casos con nota a mano y MAE real **0,19 pts** (2 pasadas, `gemini-3.5-flash-lite`), visible en el Examinador. `verify:cierre` 17/17, `verify:corrector` 29/29, `verify:sesiones` 115, `verify:srs` y `verify:planificador` en verde; `tsc` y `eslint` 0; `npm run build` 0 (`VgvJw3g8eVB5PjHDK32bo`); salud 200 con ese build, `/` y `/examinador` 307, APIs 401. | `verify:examinador` no puede pasar sin una sesión real de Supabase (responde 401 en esta máquina); el recorrido de la foto con sesión real queda como prueba manual. La transcripción necesita un modelo con visión: sin él se avisa y no se corrige. |
| 11. B3 pedagogía activa | hecho | `8343bdd`, `1b969cb`, este commit | Etapas ESO 1º–4º, Bachillerato 1º–2º y Universidad (5 ramas, cursos 1º–5º, titulación editable, ECTS y convocatorias) en `src/lib/stages/`; migración `20261120120000_education_stage` **expand-only, no aplicada a producción**; backfill con `--dry-run` por defecto; cabecera, barra lateral, Ajustes, Estadísticas y prompts dejan de asumir PAU/14. Pedagogía activa determinista (`pickTechnique`) declarada en la capa de etapa y conectada con el cierre del Paso 10 sin tocar `sessionClose.ts`. `verify:stages` (66), `verify:corrector` (29), `check`, `lint` y `build` en verde. `verify:cierre` queda **bloqueado a propósito** hasta aplicar la migración: la base de producción aún no tiene `stage` y el test crea perfiles reales. | La migración y el backfill se ejecutan a mano en Supabase (SQL abajo). El recorrido visual de Ajustes/Universidad con sesión real queda como prueba manual. |
| 12. Verificación SymPy/unidades/química | hecho | `0dfd504`, `49c5dc6`, este commit | `docs/ENCARGO.md` §3.7 cerrado **sin SymPy**: el despliegue es Node puro (no hay `Dockerfile` ni `render.yaml`; `netlify.toml:26-33` y `runtime = 'nodejs'`) y `python3` local no trae la librería. Motor determinista en `src/lib/verify/`: LaTeX → expresión, CAS acotado, unidades SI y química (masas molares IUPAC, ajuste por eliminación gaussiana con carga, reactivo limitante). Se adjunta como evidencia en `BlockResult.verification`, se le da al corrector y se pinta en `ExamResults`; **no toca la nota ni `notationPenalty`**. `verify:verificacion` 91 comprobaciones. | La solución de referencia privada y el botón «Comprobar cálculo» del catedrático van en el commit siguiente. Queda el recorrido visual con sesión real. |
| 13. Proactividad diaria | pendiente | — | — | — |
| 14. B7 modos por materia | pendiente | — | — | — |
| 15. Fase 0 de seguridad | en curso (parte segura) | este commit | RLS activo en 30/30 tablas de `public` (incluida `PushSubscription`); `anon` y `authenticated` sin privilegios (0 filas en `information_schema.role_table_grants`); anon recibe HTTP 401/42501 en las 6 tablas probadas. TLS con CA de Supabase y `sslaccept=strict`. | Defaults de `supabase_admin` siguen abiertos (requiere SQL como ese rol); faltan `prisma_app`, secretos Moodle y retry de lecturas. |
| 16. Soporte 1º ESO | hecho | `8a45b15` | `UserProfile.modality` sigue siendo la única fuente del curso; `src/lib/courseCatalog.ts` la normaliza a curso + currículo y define las nueve materias base de 1º ESO (Lengua Castellana y Literatura, Matemáticas, Geografía e Historia, Biología y Geología, Inglés, Tecnología y Digitalización, Educación Física, Música y Educación Plástica). `/ajustes` permite elegir el curso y, al activar 1º ESO, `courseApply.ts` crea de forma idempotente las materias que falten con su Catedrático IA en LOMLOE 1º ESO; cambiar de curso no borra nada. La cabecera y la barra lateral reciben el curso real y en ESO ocultan el objetivo PAU y el Examinador PAU; el coordinador de la puesta a punto y los Catedráticos IA reciben `1º ESO (LOMLOE 1º ESO)` para ajustar nivel y prerrequisitos. `tsc`, `eslint` y `npm run build` en verde. | La creación de materias al cambiar de curso y el ocultado del menú requieren una sesión real en el navegador para recorrerse a mano; la lógica está compilada y cubierta por los tipos. |
| 17. Modo apaisado / tablet | hecho | este commit | `public/manifest.json` pasa a `"orientation": "any"`. La barra lateral muestra la navegación completa con etiquetas desde `md` (768 px) con 240 px de ancho, en vez del rail de iconos que esperaba a `xl`; el contenido principal usa `xl:p-8` y 1600 px de ancho máximo, de modo que una tablet apaisada de 1024 px no pierde columnas. Las rejillas de estadísticas, retos, repaso y la puesta a punto pasan a dos columnas desde `md`; el Cuartel añade `landscape:grid-cols-2` para pantallas apaisadas. `tsc`, `eslint` y `npm run build` en verde. | La comprobación visual en tablet real no se ha hecho en este entorno; los cortes se verifican por las clases y el build, no con captura. |

Despliegue, publicación y `git push`: **fuera de alcance** del modo autónomo.

## Base de datos

- Host: `aws-0-eu-north-1.pooler.supabase.com`
- Runtime: puerto `6543` (pooler, `DATABASE_URL`); migraciones: puerto `5432` (`DIRECT_URL`), base `postgres`.
- Rol: `postgres.jwxatcbbauvlhufcfosa`. Es la base de producción; cualquier migración de esquema debe ser solo expand.
- Cuentas: `16bb4958-5288-493b-8c65-379dd31782f5` (autor, confirmada) y `3af632ee-22dc-4e75-85a8-139aa70600bf` (prueba, confirmada).

## Catedrático con clave propia y claves multiproveedor (2026-11-15)

- **Qué pasaba de verdad.** La puerta `ensureAiAccess` resolvía la clave y llamaba a `AsyncLocalStorage.enterWith` para dejarla activa «para el resto de la petición». Eso no es cierto cuando se hace desde un ayudante: `enterWith` cambia el contexto del recurso que ejecuta en ese momento, y la ruta que espera al ayudante sigue en el suyo. Resultado: la ruta entraba sin ámbito, `hasAiProviderAsync()` contestaba que no había ningún motor y el catedrático respondía con el texto local «Sin IA ahora mismo» teniendo una clave válida. Se reprodujo con Node (`enterWith` dentro de una función esperada → `undefined` en el llamante) y ahora hay un test que fija el patrón correcto.
- **El arreglo.** `ensureAiAccess` devuelve `{ denied, credentials }` y no activa nada; cada ruta llama a `activateAiCredentials(ai.credentials)` en su propio marco, justo después. `verify:ai-keys` comprueba además que las 9 rutas de IA contienen esa llamada, para que nadie vuelva al patrón roto.
- **«Groq · mejor modelo gratuito».** El rótulo salía de buscar «groq» dentro de la etiqueta `auto (Gemini + Groq)`, que contiene los proveedores de la cadena, no el que se iba a usar. Ahora es el primero de la cadena real (`engines[0]`), así que con clave de Gemini dice Gemini.
- **La clave propia manda.** `resolveAllAiCredentials` devuelve solo las claves del alumno en cuanto tiene alguna; ya no rellena con claves de plataforma de otros proveedores (antes, una cuenta de plataforma con Gemini propio podía acabar gastando Groq de plataforma). `resolveAiCredentials` de un proveedor sin clave propia lanza `ai_key_required` con un mensaje que lo explica, en vez de usar la de plataforma. Test con los cuatro señuelos de plataforma activos y una única clave propia de Groq: solo se entrega Groq.
- **Cuatro proveedores en Ajustes.** `keyFormat` valida por proveedor y acepta `google` como alias de `gemini`; `providerKeyCheck` comprueba contra el endpoint real (Gemini y Groq generan con el primer modelo de la cadena del motor; OpenRouter usa `/api/v1/key`; NVIDIA, `/v1/models`, porque su cadena de chat está vacía). El estado, la comprobación y el borrado son por proveedor, con chips en la tarjeta y las cuatro filas leídas en una sola pasada en `/ajustes`.
- **Mensaje honesto en el respaldo.** `buildLocalTutorReply` recibe los proveedores con clave propia y dice «no se ha podido usar tu clave de Gemini» en vez de «los modelos gratuitos están saturados», que era lo que confundía.

## Paso 10a: adjuntos (2026-11-14)

- Lo que faltaba: la puerta de subida no pedía sesión; `readUpload(id)` no conocía al dueño; el MIME se creía del navegador/extensión; no había tope de páginas; los PDFs con texto se marcaban como «no leídos» en proveedores sin visión; y `AiAttachment` se creaba con el `user_default` histórico.
- Ahora cada archivo vive en `data/uploads/{userId}/` y el metadato lleva el dueño. `GET /api/tutor/attachments?id=…` de otra cuenta responde 404, y `DELETE` no borra nada ajeno.
- La firma real se comprueba tras escribir y antes de indexar: una imagen con extensión `.pdf` se borra y se rechaza; un binario con `.txt` tampoco pasa. Los ZIP solo se aceptan para documentos de oficina.
- Los PDFs se cortan a **300 páginas** con mensaje claro; el archivo se borra y no queda a medias. Los archivos de más de 15 MB no se mandan como bytes: si tienen texto, se lee el texto; si son imágenes, se avisa en `notRead` y no se finge que se han visto.
- `buildDocumentContext` ya delimitaba el material; el prompt añade ahora que es **DATO, no instrucciones**. El modelo sigue sin herramientas: `open_document` es una etiqueta que ejecuta el servidor con el userId de la sesión.
- Prueba real del motor con las claves de `.env`: 7 credenciales de plataforma, Gemini falló por timeout/demanda y respondió **Groq `qwen/qwen3.8-27b`** con «OK.». La llamada directa a Gemini con imagen respondió 200 y texto con `maxOutputTokens` suficiente; con 40 tokens el modelo 3 consumía el presupuesto pensando y devolvía 0 caracteres.
- **Deuda**: `localPath` en disco no sirve en serverless. Hay que moverlo a Supabase Storage con bucket privado y rutas `{userId}/…`; no se hace en este paso.

## Aclaraciones de seguridad (2026-11-14)

- **`AiKeyAttempt`**: el contador de 5 intentos/10 min ya no vive en memoria. Una fila por intento, RLS activa y 0 grants para `anon`/`authenticated`; la transacción bloquea el perfil de la cuenta para que dos peticiones simultáneas no se cuelen. Migración `20261114194500_ai_key_attempts` aplicada.
- **AAD**: `UserAiKey` usa `userId:provider`. El test falla con otro `userId` y con el mismo `userId` y otro `provider`. Las filas creadas antes se descifran con el AAD antiguo y se recifran con el nuevo en la misma lectura.
- **`PRISMA_APP_DATABASE_URL`**: no se ha creado el rol `prisma_app` ni se ha cambiado la conexión de runtime. En producción solo se ejecutaron `npx prisma migrate deploy` para `UserAiKey` y `AiKeyAttempt`; la app sigue usando `DATABASE_URL`. El rol dedicado es el paso 15 y no estaba autorizado. Se retiró la instrucción de crearlo de `.env.example`.
- **Servidor local**: el proceso que atendía `:3000` era anterior al build y al `.env` actuales (arrancado a las 13:19; `.env` modificado a las 17:29; build a las 18:12). Se paró y se levantó el build nuevo. Eso explicaba los esqueletos de `/ajustes` (chunks borrados) y el «sin IA» (entorno viejo), no el resolver.

## Fase 0 parcial: RLS y API anónima (2026-11-13)

- Backup previo fuera del repo: `C:/Users/ojeda/brainup-backups/brainup-pre-rls-20261113.dump`,
  **524.438 B**, SHA-256 `5141a7f8e65df91ef3413f24ca58d469008037ab3ff046d46e08381abc5f1f36`,
  605 entradas TOC. Snapshot de permisos en `grants-before.json` (misma carpeta).
- `prisma migrate diff` (producción → `schema.prisma`): solo dos sentencias,
  `ALTER TABLE "FocusSession" ALTER COLUMN "updatedAt" DROP DEFAULT;` y lo mismo
  en `ReviewCard`. No hay tablas/columnas ausentes de `ebau_focus`. **No aplicado.**
- Antes: anon leía por REST `UserProfile` (1 fila/30 columnas), `Subject` (1/14),
  `Note` (1/12), `AiMessage` (1/9) y `_prisma_migrations` (1/8); `ErrorLog` 0 filas.
- Rol de Prisma: `postgres`, `rolbypassrls = true`, propietario de las 29 tablas;
  0 políticas RLS; 58 grants (29 tablas × anon/authenticated, todos los privilegios).
- Después: las 6 tablas devuelven **HTTP 401 / 42501 permission denied**; 29/29 con
  RLS; 0 grants; `UserProfile` 2, `Subject` 9 y `StudyBlock` 25 siguen visibles para
  Prisma; `/api/salud` 200 y `/login` 200. Sin revertir.
- Límite: los default privileges de `supabase_admin` en `public` siguen incluyendo
  a anon/authenticated; `postgres` no es miembro y recibe «permission denied to
  change default privileges». Las tablas creadas por Prisma sí nacen cerradas.
- Rollback preparado: `DISABLE RLS` + `GRANT ALL` usando `grants-before.json` y el
  dump. No fue necesario.

## Corte actual (2026-11-13)

Hechos y verificados: pasos **1 a 8**. El plan diario se decide con reglas
(determinista, una sola vez, con lock), se invalida con motivo, conserva lo
empezado, calibra horas con sesiones reales y el Cuartel tiene un solo «Ahora»,
selector de energía y aviso push.

Pendientes: pasos **1 a 3 de claves de IA** (bloqueado: falta `SECRETS_KEY_V1`) y pasos **9 a 14**. No se han empezado. Bloqueos concretos conocidos:

- 9: no existen `responseSchema`, `open_document` ni la confirmación Zod de
  restricciones.
- 10: no existen `frontHash`, `TutorSessionOutcome` en el cierre ni doble
  corrección con mediana; el examinador actual no los cubre.
- 11: la pedagogía activa no está separada del cierre del paso 10.
- 12: no hay SymPy ni verificación de unidades/química.
- 13: la proactividad diaria con horas de silencio no está implementada.
- 14: no hay modos por materia.

## Última verificación (2026-11-13)

- `npm run build`: exit 0 con el código actual.
- `/api/salud`: HTTP 200, `database.ok = true`; `/` → 307 a `/login`; `/login` 200; `/api/moodle/status` y `/api/planner` 401.
- `npx tsc --noEmit`: limpio tras el paso 8.
- `npm run lint`: limpio tras el paso 8.
- `node scripts/verify-sesiones.js`: 115 comprobaciones en verde (incluye calibración por unidad, microacción de 2 min y presupuesto del repaso SM-2).
- `node scripts/verify-planificador.js`: 11 comprobaciones en verde.
- Migración `20261113213000_push_reminder` aplicada a producción; `PushSubscription` nace con RLS y sin grants de anon.
- `npx prisma validate`: esquema válido.
- Recuentos post-1e: `UserProfile` 1, `_prisma_migrations` 2, 473 filas en el UUID del autor (471 migradas + 2 `SystemIssue` del vigilante creadas a las 19:05:36Z), 0 en la cuenta de prueba, 0 restos de `user_default`.
- Ensayo local: restauración con `--exit-on-error` y 26/26 tablas iguales; `migrate-user-id.js --apply` contra `127.0.0.1:55432/brainup_test`.
- Dump previo a 1e ignorado por git (`.gitignore:18`).
- TLS: sin `NODE_TLS_REJECT_UNAUTHORIZED` en `.env`, `next.config.js` ni scripts. Prisma conecta con `sslmode=verify-full&sslaccept=strict` y la CA pública de Supabase (`prisma/certs/supabase-prod-ca-2021.crt`, huella SHA-256 `807025AD…`); Gemini responde 200 con verificación normal. `pg_dump` usa `sslrootcert`.
- Supabase informa `disable_signup: false` en `/auth/v1/settings`; la app no expone registro, pero el toggle del proyecto no está desactivado.

## Paso 0 de claves de IA (2026-11-14)

- `npx tsc --noEmit`: exit 0.
- `npx eslint src scripts --ext .ts,.tsx,.js`: exit 0.
- `node scripts/verify-ai-keys.js`: 9/9 en verde. Cubre: 402 `ai_key_required` real para un usuario fuera de la lista; ámbito vacío y sin ámbito → 0 llamadas al proveedor; clave de usuario usada y clave de plataforma ausente de todas las peticiones; la clave no aparece en el estado; `src/` solo lee claves en `credentials.ts`; las 7 rutas de IA pasan por `ensureAiAccess`.
- `node scripts/verify-ai-engine.js`: TODO EN VERDE. Se actualizaron expectativas caducadas: los avisos ya no nombran variables del `.env` (ahora mandan a Ajustes), el proveedor se da por caído tras 3 fallos y un 413 se reintenta hasta 3 veces recortando el prompt. El script activa `BRAINUP_AI_TEST_MODE` y limpia el entorno para ser hermético.
- `npm run build`: exit 0 (antes hubo que liberar el DLL de Prisma: un proceso tenía bloqueado `query_engine-windows.dll.node`; tras borrarlo se regeneró).
- `next start` en `:3000`: `/api/salud` 200; `/` 307 a `/login`; `POST /api/tutor` 401 y `/api/ia/status` 401 sin sesión (la puerta de auth va antes que la de IA).
- Paso 1 bloqueado a propósito: `SECRETS_KEY_V1` no existe en `.env`. Se genera con `openssl rand -base64 32`; no se ha inventado ni se versiona. Sin esa clave no se implementa el cifrado de `UserAiKey`.

## Claves propias (pasos 1–3, 2026-11-14)

- `SECRETS_KEY_V1` presente y con 32 bytes decodificados; `PLATFORM_AI_USER_IDS` con el UUID del autor. Ninguna de las dos se versiona.
- Migración expand `20261114120000_user_ai_key` aplicada a producción: tabla `UserAiKey`, único `(userId, provider)`, FK en cascada, **RLS activa y 0 grants para anon/authenticated**. No toca filas existentes.
- `src/lib/security/vault.ts` es genérico (no conoce `UserAiKey`): AES-256-GCM, formato `v1.iv.tag.ct`, IV de 12 bytes aleatorio, tag de 16, AAD explícito. La clave maestra se lee en cada operación: si falta o no mide 32 bytes, solo falla la operación, no el arranque ni el build.
- `verify-vault.js`: 11 comprobaciones en verde (ida y vuelta, formato, IV distinto, AAD de otra cuenta, tag alterado, texto alterado, versión desconocida, formato incompleto, falta de clave, longitud incorrecta).
- `verify-user-ai-key.js`: 10 comprobaciones en verde contra la cuenta de prueba (cifra sin dejar la clave, AAD `userId:provider` que falla con otra cuenta y con otro proveedor, migración de una fila antigua con AAD `userId`, estado con últimos 4, IV distinto al reguardar, límite al sexto intento, errores 401/429/red saneados sin clave ni URL, RLS/grants y borrado).
- Ajustes: tarjeta «Mi clave de IA» con estado, últimos 4, comprobación y borrado; formulario deshabilitado con aviso claro si el vault no está listo. `AiEngineCard` de plataforma solo se pinta para los ids de la lista. Aviso «Añadir mi clave» en el catedrático y en la puesta a punto.
- `npx tsc --noEmit`, `npx eslint src scripts`, `npm run build`: 0. Servidor `next start`: `/api/salud` 200, `/` y `/ajustes` 307, `/api/ia/mi-clave` y `/api/tutor` 401 sin sesión.
- Límite real: no hay contraseña de la cuenta de prueba en este entorno, así que el recorrido de pegar/borrar clave con sesión queda como prueba manual de 5 minutos; la política y el 402 se verifican con el UUID real de esa cuenta.

## Paso 9 (2026-11-14)

- `src/lib/planner/constraints.ts`: tres restricciones cerradas con Zod (`max_minutes` 10–480, `avoid_subject`, `only_subject`; máximo 5). Una respuesta del modelo con un solo elemento inválido se rechaza entera; no se guarda «lo que se haya podido entender».
- `src/lib/planner/constraintAi.ts`: llama a `generateContent` con `responseMimeType: application/json` y `responseSchema`; el esquema y el cuerpo de la petición no contienen `userId`. La clave se resuelve por usuario.
- `src/lib/planner/constraintActions.ts`: interpretar (no guarda), confirmar (revalida Zod y que las materias existan) y borrar. Guarda en `PlanConstraint`, marca el plan como invalidado y el siguiente `ensureTodayPlan` reconstruye respetando las restricciones.
- `src/lib/dayPlan.ts`: filtra candidatos por materia, aplica el máximo de minutos y no inyecta repasos SM-2 de materias excluidas.
- `src/lib/tutor.ts` y la ruta del tutor: reciben restricciones confirmadas y `teacherMethod` de la unidad en curso. El saludo de `TutorChat` se construye por reglas con errores, examen, unidad débil y método del profesor.
- `src/lib/tutorDocuments.ts`: `openDocument(userId, kind, query)` con `db(userId)`; la ruta lo usa para confirmar el apunte. La respuesta lleva `?doc=note:ID`; el panel sigue siendo `NoteSplitPanel` y no hay SSE.
- `node scripts/verify-constraints.js`: 8/8 (validación, rechazo entero, esquema sin userId, comparación de materias, intérprete con responseSchema, apertura server-side sin SSE y saludo por reglas).
- `npx tsc --noEmit`, `npx eslint src scripts`, `npm run build`: 0. `node scripts/verify-ai-engine.js`: TODO EN VERDE.
- Límite: no hay sesión de navegador para confirmar una restricción de extremo a extremo; el filtrado del plan no se ha probado contra datos reales del alumno, solo el contrato y el código compilado.

## Formato de clave de IA con punto (2026-11-14)

- `src/lib/ai/keyFormat.ts`: regla única `^[A-Za-z0-9._-]+$` y mensaje compartido. Acepta el prefijo `AQ.` que Google empezó a emitir y sigue rechazando espacios, saltos de línea y controles. Se importa en el cliente, así que no arrastra nada de servidor.
- `src/app/ajustes/aiKeyActions.ts`: el esquema Zod usa esa regla en vez de la antigua `^[A-Za-z0-9_-]+$`; el servidor sigue siendo la puerta real (20–200 caracteres).
- `src/components/ajustes/AiKeyCard.tsx`: validación previa al envío con la misma función, `pattern` y `title` en el input y placeholder `AIza… o AQ.…`. Un espacio pegado al copiar se recorta antes de validar.
- `node scripts/verify-user-ai-key.js`: 12/12. Las dos comprobaciones nuevas cubren la aceptación de `AQ.…` y que formulario y acción ya no conservan la regla antigua.
- `npx tsc --noEmit`: 0. `npm run lint`: 0.
- Límite: no se ha pegado una clave `AQ.` real desde el navegador; la comprobación es de contrato y de código.

## /ajustes seguía rechazando AQ. (2026-11-14)

El síntoma no era de validación: el código en disco ya aceptaba el punto. En `:3000` convivían **dos** servidores Next, y el que respondía (PID 19832) era de antes del arreglo, con el build antiguo cargado en memoria. Además retenía `query_engine-windows.dll.node`, así que `npm run build` moría en `prisma generate` con EPERM y nunca llegaba a sustituir `.next`.

- Parados el supervisor (`npm run sirve -- --stop`, PIDs 17776/18792/15032) y el servidor huérfano 19832; puerto 3000 libre y `prisma generate` volvió a funcionar.
- `npm run build` completo: exit 0, `BUILD_ID=MX8HceCDcAJ8moSrQ_64j`.
- `next start` servicio desde el supervisor: `/api/salud` devuelve `build: MX8HceCDcAJ8moSrQ_64j`, el HTML de `/login` incluye ese mismo id, `/ajustes` 307 sin sesión y `/login` 200.
- Bundle servido (`/_next/static/chunks/24888fa97-9uy.js`): el mensaje es el nuevo («puntos, guiones y guiones bajos») y el literal viejo aparece **0** veces.
- Recorrido cliente + acción verificado con la acción real compilada y sesión simulada (12 comprobaciones): `AQ.` con punto se acepta y guarda; espacios/saltos pegados al copiar se recortan; espacio interior y `U+200B` se rechazan con el mensaje nuevo; clave corta mantiene su mensaje; el proveedor no se llama cuando el formato falla.
- `POST /ajustes` con `Next-Action` real y sin sesión: 307 a `/login` (la puerta de auth va antes), y el mensaje viejo no aparece en la respuesta.
- Límite: no hay credenciales de la cuenta de prueba en este entorno, así que el clic real desde el navegador con sesión sigue siendo prueba manual; lo anterior cubre el código servido y la acción real.

## Catedrático «sin IA» con clave válida: causa y arreglo (2026-11-14)

No era la clave ni el formato. El catálogo real de Google anunciaba `gemini-3.8-flash` y `gemini-3.7-flash` con más puntuación que el resto, y esos dos no responden: `3.8` tardaba 23 s y devolvía 503 «high demand»; `3.7` no contestaba en 12 s. Con un intento de 7 s por modelo y un turno de 30 s, la cadena se gastaba entero en ellos y moría por presupuesto antes de llegar a `3.6-flash` (2,2 s) o `3.5-flash-lite` (1,0 s), que sí respondían. El catedrático degradaba a `tutorFallback` y el alumno leía «⚠️ Sin IA ahora mismo».

La otra mitad del síntoma: «Guardar y comprobar» hacía `GET /models?pageSize=1`, que solo demuestra que la clave está activa. Por eso la tarjeta decía VÁLIDA mientras el motor fallaba. Ahora la comprobación **genera** con el primer modelo de la cadena del motor.

Medido con `node scripts/check-ai-models.js` y llamadas directas (sin imprimir claves):

- `gemini-3.8-flash` → 503 a los 23 326 ms; `gemini-3.7-flash` → sin respuesta en 12 s.
- `gemini-3.6-flash` → 2 263 ms · `gemini-3.5-flash` → 1 144 ms · `gemini-3.5-flash-lite` → 961 ms · `gemini-3.1-flash-lite` → 513 ms · `gemini-3-flash-preview` → 825 ms.
- `gemini-2.5-flash`, `2.5-flash-lite` y `1.5-flash` → 404 «no longer available to new users».
- `llama-3.3-70b-versatile` (Groq) → 404; `nemotron` (NVIDIA) → 404 «Not found for account» en todos sus modelos de chat.
- Llamada real del motor con la cadena nueva: `gemini-3.5-flash-lite`, **1 086 ms**, respuesta correcta, un solo intento.

## Enrutado por capacidad y modelos en configuración (2026-11-14)

- `src/lib/ai/models.json` es ahora la cadena prioritaria por proveedor (orden, `vision`, `preview`, `exclude`). `AI_GEMINI_MODELS`, `AI_GROQ_MODELS`, `AI_OPENROUTER_MODELS` y `AI_NVIDIA_MODELS` la sobrescriben sin tocar código. El catálogo real solo completa por detrás.
- `ALLOW_PREVIEW_MODELS` (0 por defecto; 1 en este `.env` local) decide si entran los preview, sin forzar `AI_PROVIDER`. En producción debe quedarse a 0.
- Un turno con imagen o PDF solo se ofrece a modelos con visión: la cadena se filtra antes de elegir y, si no queda ninguno, se avisa con un mensaje claro. Esos bytes no se reenvían a Groq ni a otro proveedor como plan B.
- Un timeout ya no se reintenta contra el mismo modelo: se clasifica `timeout`, se aparta y el turno sigue. Antes gastaba 7 s + 0,6 s + 7 s en el modelo colgado.
- `scripts/check-ai-models.js` sondea cada modelo configurado y enseña estado, milisegundos y política (excluido, preview, sin clave), sin imprimir claves.

## Fallback, adjuntos y límites (2026-11-14)

- `node scripts/verify-ai-keys.js`: 10/10. La comprobación nueva pone a Gemini caído con un alumno que solo tiene su clave propia y verifica **cero** peticiones a Groq, NVIDIA y OpenRouter, y un mensaje claro.
- `docs/PROVEEDORES-IA.md`: qué proveedor puede recibir texto, texto extraído de documentos, imágenes y PDF, y en qué casos.
- `scripts/verify-tutor-adjuntos.js` retirado: exigía una sesión real de Supabase (siempre 401) y sus filtros de relación Prisma eran inválidos. Su cobertura la dan `verify:attachments` (12/12) y `verify:ai`.
- Tope por archivo: **25 MB** por defecto, `AI_MAX_ATTACHMENT_MB` / `NEXT_PUBLIC_AI_MAX_ATTACHMENT_MB` para subirlo (512 en este `.env` local, máximo 512). El conjunto por mensaje, 300 MB por defecto (`AI_MAX_TURN_ATTACHMENT_MB`).
- `AiKeyAttempt`: barrido de filas de más de 24 h al contar un intento, como mucho una vez por hora, con el cliente crudo porque `db(userId)` dejaría fuera a las cuentas dormidas. Cubierto en `verify-user-ai-key.js` (13/13).

## Paso 10 (2026-11-15)

- **Cierre idempotente de verdad.** La clave no la inventa el navegador: la calcula el servidor como `sesion:<agente>:<día>`. El primer paso de la transacción es crear el resultado con esa clave, así que dos peticiones simultáneas chocan contra el índice único `[userId, sessionKey]` y solo una escribe fichas y tarjetas. La segunda recibe `alreadyClosed` con los mismos números. Si ya estaba cerrada, el camino rápido no escribe nada ni deja un error de índice en el log.
- **Qué deja una sesión.** Solo lo que el alumno confirma: fichas de `ErrorLog` con causa raíz cerrada (`concepto`, `calculo`, `lectura_enunciado`, `tiempo`, `bloqueo`), tarjetas con `frontHash` (FNV-1a del enunciado normalizado, sin crypto para poder compartirlo con el cliente) y `TutorSessionOutcome`. `invalidatePlan` va **fuera** de la transacción: si falla, el cierre está guardado y el resultado lo dice (`planInvalidated: false`).
- **Corrector tipo tribunal.** Cada pasada se valida entera con Zod; un JSON fuera de esquema se descarta y no se convierte en 0. Con dos pasadas la mediana es la media de ambas; con una, manda esa; un bloque que ninguna pasada puntúa vale 0 y se dice. Los cuartos de punto se redondean como en la PAU y `scores` guarda las notas de cada pasada para poder auditarlas.
- **Foto manuscrita.** El archivo se sube por el pipeline normal (`/api/tutor/attachments`) y nunca se inventa su contenido: se transcribe con un modelo con visión y se corrige el texto resultante, con `confidence` y `missingParts`. El envío del simulacro usa la transcripción y añade al informe una frase con la confianza; si la letra no se lee o falta visión, lo dice en vez de corregir un texto inventado. El alumno puede pedir «Ver transcripción» antes de entregar.
- **Banco y MAE.** Cuatro casos de frontera con nota puesta a mano (dos de Matemáticas II, uno de Física, uno de Lengua). Se corrigen dos veces y se publica el error absoluto medio por materia y por bloque, sin esconderlo cuando es alto. Medición real de este corte: `mates2-algebra-1` 0,50; `mates2-analisis-1` 0,00; `fisica-campo-1` 0,00; `lengua-comentario-1` 0,25; **MAE 0,19**. El caso de Álgebra está mal a propósito (una respuesta que se contradice) y el corrector lo baja a 0,5: prefiere pecar de duro antes que dar por bueno un desarrollo incoherente.
- **Pruebas.** `verify:cierre` usa una cuenta temporal y la borra (cascadas incluidas): 17 comprobaciones con el doble cierre, la validación y el `frontHash`. `verify:corrector` 29/29 sin gastar IA. `verify:sesiones` 115 y `verify:srs` siguen verdes. `npx tsc --noEmit` y `npx eslint src scripts` 0. `npm run build` 0; el servidor nuevo sirve `VgvJw3g8eVB5PjHDK32bo`, salud 200 con base OK, `/` y `/examinador` 307 a `/login`, y las tres rutas nuevas del examinador 401 sin sesión.
- **Límite honesto.** `verify:examinador` es end-to-end por HTTP y necesita una sesión real; aquí responde 401, así que no se ha podido recorrer la foto ni la entrega con sesión. La transcripción depende de que haya un modelo con visión disponible; sin él, el aviso es explícito.

## Paso 11 (2026-11-20)

**Definición ratificada.** PROGRESS.md no definía el Paso 11 (solo decía «B3 pedagogía activa») y en `docs/ENCARGO.md` «B3» es otra cosa (salidas persistentes, ya cerrada en el Paso 10). Se adoptó esta definición: *el Catedrático conduce cada sesión con una técnica de aprendizaje activo elegida por reglas según etapa, materia, errores y temario; la técnica se declara en el prompt y el cierre confirmado por el alumno sigue siendo el del Paso 10*. Queda escrito aquí para que no vuelva a haber ambigüedad.

- **Commit 1 (`8343bdd`) — etapas.** Enum `EducationStage` y columnas `stage` (default `BACHILLERATO`), `gradeLevel`, `trackKey` y `degreeName` en `UserProfile`, todas expand-only y sin tocar `modality`. `src/lib/stages/catalog.ts` concentra escala (0–10 vs PAU /14), herramientas visibles, valores del planificador y personalidad; `getStageConfig` resuelve desde la columna o desde `modality`. ESO trae plantilla LOMLOE en 1º–4º (1º conserva exactamente sus nueve materias), Bachillerato sus tres modalidades sin crear materias, y Universidad sus cinco ramas con 4 troncales y créditos ECTS por rama. `applyCourseToProfile` es el único escritor de los campos derivados y sigue siendo idempotente. Cabecera, barra lateral, `/ajustes` (selector de etapa con titulación editable) y `/estadisticas` dejan de enseñar 14 donde no hay PAU.
- **Commit 2 (`1b969cb`) — prompts en capas.** `src/lib/stages/prompts.ts` separa base pedagógica, capa de etapa y capa de materia. ESO y Bachillerato mantienen **palabra por palabra** el texto anterior (test de paridad); Universidad estrena capa propia con guía docente, ECTS y convocatorias. `activePedagogy.ts` elige técnica por reglas deterministas (errores > examen próximo > unidades flojas > tipo de materia > etapa) y entra en el prompt tras la capa de etapa. No importa `sessionClose.ts` ni escribe `StudyBlock`.
- **Commit 3 (este) — verificación.** `scripts/verify-stages.js` comprueba inferencia, catálogo, plantillas, ida y vuelta de `modality`, paridad de prompts, determinismo de la técnica, que la migración siga siendo expand-only y que no haya condicionales por etapa fuera de `src/lib/stages/`, `courseCatalog.ts` y el selector de Ajustes.

### SQL exacto para Supabase (ejecutar antes del `git push`)

Con copia de seguridad verificada y `DIRECT_URL` (puerto 5432). **No se ha aplicado desde este entorno.**

```sql
-- 1. Etapas educativas (expand-only). Idempotente solo si el enum no existe:
--    si ya existe, saltar el CREATE TYPE.
CREATE TYPE "EducationStage" AS ENUM ('ESO', 'BACHILLERATO', 'UNIVERSIDAD');

ALTER TABLE "UserProfile"
  ADD COLUMN "stage" "EducationStage" NOT NULL DEFAULT 'BACHILLERATO',
  ADD COLUMN "gradeLevel" TEXT,
  ADD COLUMN "trackKey" TEXT,
  ADD COLUMN "degreeName" TEXT;
```

Después, desde un entorno con la `DATABASE_URL` correcta:

```bash
npx prisma migrate deploy                  # marca la migración en _prisma_migrations
node scripts/backfill-education-stage.js           # simulación: cuenta perfiles
node scripts/backfill-education-stage.js --apply   # escribe stage/gradeLevel/trackKey/degreeName
```

El backfill **no modifica `modality`** ni borra materias. En modalidades desconocidas deja `stage = BACHILLERATO` y el curso nulo, sin inventar datos. Es idempotente: la segunda pasada no encuentra filas pendientes.

### Plan de rollback

1. Revertir el código al commit anterior (`ecca48a` o el que corresponda): la app sigue funcionando porque nacía leyendo solo `modality`.
2. Las columnas y el enum pueden quedarse: son expand y ningún código antiguo las lee. Si se quieren retirar, con copia previa:
   `ALTER TABLE "UserProfile" DROP COLUMN "degreeName", DROP COLUMN "trackKey", DROP COLUMN "gradeLevel", DROP COLUMN "stage"; DROP TYPE "EducationStage";`
3. El backfill no toca `modality`, así que no hay datos de curso que restaurar.

**Límites honestos.** La migración se escribió a mano y se validó con `prisma validate`; no se ejecutó `prisma migrate dev` porque la `DATABASE_URL` de este entorno apunta a producción y la regla del proyecto prohíbe migrar producción desde aquí. Por eso `verify:cierre` falla ahora con `The column stage does not exist in the current database`: es el resultado esperado y la prueba de que el orden obligatorio es **SQL → deploy**, nunca al revés. Tras aplicar la migración, ese test vuelve a correr sin tocar su código. No se ha recorrido Ajustes/Universidad en navegador con sesión real; lo cubierto son los contratos, el catálogo, los prompts y el build.

**Orden de despliegue obligatorio.** El código nuevo lee `stage` en cabecera, barra lateral y perfil; si se publica antes de la migración, esas consultas fallan. Aplicar primero el SQL (o `prisma migrate deploy`) y después desplegar.

## Paso 12 (2026-11-20)

**Definición del encargo** (`docs/ENCARGO.md:236-241`, §3.7): verificación simbólica del bloque matemático, de unidades en físico/químico y de ajuste y estequiometría en química. **Un fallo se marca; no se convierte en cero.**

- **Sin SymPy, y se dice por qué.** `package.json` no tiene ningún motor CAS ni puente con Python; no hay `Dockerfile` ni `render.yaml` en el repo y la configuración versionada es `netlify.toml` con `@netlify/plugin-nextjs` (funciones Node, `NODE_VERSION = "20"`). En local, `python3` existe pero `import sympy` falla. Un motor que dependiera de Python habría fallado en producción sin avisar.
- **Motor determinista (`src/lib/verify/`).** `latex.ts` normaliza fracciones, raíces, potencias, subíndices, unidades en `\text{}`, decimales con coma y superíndices Unicode; rechaza con motivo matrices, integrales, `±` y comandos que no entiende. `cas.ts` analiza con precedencia, multiplicación implícita y funciones, y decide equivalencia por muestreo determinista (10 puntos fijos). `units.ts` trabaja con las 7 dimensiones SI, prefijos y unidades derivadas; distingue homogeneidad de conversión (`N/C` = `V/m`). `chemistry.ts` + `elements.ts` calculan masas molares con tabla IUPAC, ajustan ecuaciones por eliminación gaussiana exacta **incluyendo la carga** y resuelven reactivo limitante.
- **`no_verificable` es una respuesta de primera clase.** Redox sin solución única, orgánica, temperaturas con offset, expresiones fuera de gramática y respuestas en blanco no se convierten en fallos: se dice qué no se ha podido comprobar.
- **Integración sin tocar la nota.** `gradeWithRubricMedian` y `gradeEbauWithRubric` calculan la verificación antes de corregir, se la pasan al modelo como evidencia y adjuntan el resultado a `BlockResult.verification`. `ExamResults` lo pinta con su sello. La puntuación sigue siendo la mediana del corrector y `notationPenalty` no cambia.
- **Pruebas.** `scripts/verify-verificacion.js` compila `src/lib/verify` y ejecuta **91 comprobaciones** (LaTeX, CAS, unidades, química, contrato de marcado) sin gastar IA. `verify:corrector` sigue en 29.
- **Límites honestos.** Sin caret, `NO3-` se lee como nitrato (−1) y `Fe3+` como hierro(III); es una convención de aula, no una certeza. La química redox compleja y las disoluciones con actividades quedan fuera. No se ha recorrido `ExamResults` en navegador con un simulacro real corregido.

## Deuda técnica anotada (2026-11-14)

- **Subida directa a Supabase Storage con URL firmada**: hoy el archivo viaja en el cuerpo de la petición a la función serverless, y ahí el tope es mucho más bajo que los 25–512 MB del formulario (Netlify corta el cuerpo antes). Para archivos grandes hay que pedir una URL firmada al servidor, subir el binario del navegador a Storage y guardar solo la ruta en `AiAttachment`.
