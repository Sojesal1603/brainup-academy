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
| 7. Entradas reales (`loadInputs`/`buildCandidates`/`toRow`) | pendiente | — | — | — |
| 8. UX del Cuartel | pendiente | — | — | — |
| 9. Restricciones y contexto del tutor | pendiente | — | — | — |
| 10. Cierre de sesión, corrector, foto y banco | pendiente | — | — | — |
| 11. B3 pedagogía activa | pendiente | — | — | — |
| 12. Verificación SymPy/unidades/química | pendiente | — | — | — |
| 13. Proactividad diaria | pendiente | — | — | — |
| 14. B7 modos por materia | pendiente | — | — | — |
| 15. Fase 0 de seguridad | en curso (parte segura) | este commit | RLS activo en 29/29 tablas de `public`; `anon` y `authenticated` sin privilegios (0 filas en `information_schema.role_table_grants`); anon recibe HTTP 401/42501 en las 6 tablas probadas. TLS con CA de Supabase y `sslaccept=strict`. | Defaults de `supabase_admin` siguen abiertos (requiere SQL como ese rol); faltan `prisma_app`, secretos Moodle y retry de lecturas. |

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

Hechos y verificados: pasos **1 a 6**. El plan diario ya se decide con reglas
(determinista, una sola vez, con lock), se invalida con motivo y conserva lo
empezado.

Pendientes: pasos **7 a 14**. No se han empezado. Bloqueos concretos conocidos:

- 7: falta calibrar `estimatedHours` con `FocusSession`/`SrsReview` y mostrar
  «estimado» en la UI; el resto de entradas reales ya existe en `dayPlan.ts`.
- 8: falta el selector de energía que escriba el plan y el push a la hora
  elegida; «Ahora» y las microtareas ya existen.
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
- `npx tsc --noEmit`: limpio tras el paso 6.
- `npm run lint`: limpio tras el paso 6.
- `npx prisma validate`: esquema válido.
- Recuentos post-1e: `UserProfile` 1, `_prisma_migrations` 2, 473 filas en el UUID del autor (471 migradas + 2 `SystemIssue` del vigilante creadas a las 19:05:36Z), 0 en la cuenta de prueba, 0 restos de `user_default`.
- Ensayo local: restauración con `--exit-on-error` y 26/26 tablas iguales; `migrate-user-id.js --apply` contra `127.0.0.1:55432/brainup_test`.
- Dump previo a 1e ignorado por git (`.gitignore:18`).
- TLS: sin `NODE_TLS_REJECT_UNAUTHORIZED` en `.env`, `next.config.js` ni scripts. Prisma conecta con `sslmode=verify-full&sslaccept=strict` y la CA pública de Supabase (`prisma/certs/supabase-prod-ca-2021.crt`, huella SHA-256 `807025AD…`); Gemini responde 200 con verificación normal. `pg_dump` usa `sslrootcert`.
- Supabase informa `disable_signup: false` en `/auth/v1/settings`; la app no expone registro, pero el toggle del proyecto no está desactivado.
