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
| 0. Claves de IA por usuario (pasos 0–3) | hecho | este commit | Política única en `credentials.ts` (propia → `PLATFORM_AI_USER_IDS` → 402 `ai_key_required`) y motor sin claves de entorno. `UserAiKey` guarda la clave cifrada con AES-256-GCM (`lib/security/vault.ts`, formato `v1.iv.tag.ct`, AAD = userId, IV aleatorio). Ajustes permite guardar/comprobar/borrar con Zod, límite de 5 intentos/10 min, estados `sin_comprobar|valida|invalida|sin_cuota` y solo los últimos 4. `/api/ia/mi-clave` y la tarjeta de Ajustes muestran el estado con la sesión, sin `service_role`. `verify-vault` 11/11, `verify-user-ai-key` 9/9 (RLS activa, 0 grants anon/authenticated), `verify-ai-keys` 9/9, motor en verde, build/tsc/lint 0. | Nada de cifrado; el flujo de pegar/borrar con la cuenta de prueba requiere sesión real (no hay contraseña en este entorno). |
| 9. Restricciones y contexto del tutor | pendiente | — | — | — |
| 10. Cierre de sesión, corrector, foto y banco | pendiente | — | — | — |
| 11. B3 pedagogía activa | pendiente | — | — | — |
| 12. Verificación SymPy/unidades/química | pendiente | — | — | — |
| 13. Proactividad diaria | pendiente | — | — | — |
| 14. B7 modos por materia | pendiente | — | — | — |
| 15. Fase 0 de seguridad | en curso (parte segura) | este commit | RLS activo en 30/30 tablas de `public` (incluida `PushSubscription`); `anon` y `authenticated` sin privilegios (0 filas en `information_schema.role_table_grants`); anon recibe HTTP 401/42501 en las 6 tablas probadas. TLS con CA de Supabase y `sslaccept=strict`. | Defaults de `supabase_admin` siguen abiertos (requiere SQL como ese rol); faltan `prisma_app`, secretos Moodle y retry de lecturas. |

Despliegue, publicación y `git push`: **fuera de alcance** del modo autónomo.

## Base de datos

- Host: `aws-0-eu-north-1.pooler.supabase.com`
- Runtime: puerto `6543` (pooler, `DATABASE_URL`); migraciones: puerto `5432` (`DIRECT_URL`), base `postgres`.
- Rol: `postgres.jwxatcbbauvlhufcfosa`. Es la base de producción; cualquier migración de esquema debe ser solo expand.
- Cuentas: `16bb4958-5288-493b-8c65-379dd31782f5` (autor, confirmada) y `3af632ee-22dc-4e75-85a8-139aa70600bf` (prueba, confirmada).

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
- `verify-user-ai-key.js`: 9 comprobaciones en verde contra la cuenta de prueba (cifra sin dejar la clave, descifra solo con su userId, estado con últimos 4, IV distinto al reguardar, límite al sexto intento, errores 401/429/red saneados sin clave ni URL, RLS/grants y borrado).
- Ajustes: tarjeta «Mi clave de IA» con estado, últimos 4, comprobación y borrado; formulario deshabilitado con aviso claro si el vault no está listo. `AiEngineCard` de plataforma solo se pinta para los ids de la lista. Aviso «Añadir mi clave» en el catedrático y en la puesta a punto.
- `npx tsc --noEmit`, `npx eslint src scripts`, `npm run build`: 0. Servidor `next start`: `/api/salud` 200, `/` y `/ajustes` 307, `/api/ia/mi-clave` y `/api/tutor` 401 sin sesión.
- Límite real: no hay contraseña de la cuenta de prueba en este entorno, así que el recorrido de pegar/borrar clave con sesión queda como prueba manual de 5 minutos; la política y el 402 se verifican con el UUID real de esa cuenta.
