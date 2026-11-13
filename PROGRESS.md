# PROGRESS — BrainUp Academy

Registro vivo. Cada fila se actualiza en el mismo commit que cierra su paso.
Estados: `pendiente`, `en curso`, `bloqueado`, `hecho`.

| Paso | Estado | Commit | Evidencia | Pendiente |
| --- | --- | --- | --- | --- |
| Docs (ENCARGO/PLAN/PROGRESS) | hecho | `e170cf3`, `0d0640b` | Los tres archivos existen y se commitean solos antes de seguir. | Sustituir `docs/ENCARGO.md` si el autor pega el texto literal. |
| 1. Identidad única Supabase | hecho | `d424a11`, `26518c3`, `2a2df35`, este commit | 1a–1d ya verificados. 1e aplicada el 2026-11-13T19:05:00Z sobre `aws-0-eu-north-1.pooler.supabase.com:5432` (no local): `UserProfile` = `16bb4958-…`, 471 filas movidas con `ON UPDATE CASCADE`, 0 restos de `user_default`, 24/24 tablas cuadradas. Ensayo previo en Postgres 17 local: 26/26 recuentos idénticos y migración de 471 filas con 0 restos. Dump nuevo `data/backups/brainup-pre-1e-20261113.dump` (513.383 B, SHA-256 `60ed96ef…`), legible con `pg_restore -l` (591 entradas). Build 0, salud 200, `/` → `/login`, `/login` 200, APIs 401. Cuenta de prueba con 0 filas. | Nada de 1e. Quedan los `@default("user_default")` transitorios (1f). |
| 2. Esquema expand (PlanState, PlanConstraint, TutorSessionOutcome) | hecho | este commit | Tres tablas creadas con `@@unique([userId, day])`, índices y FKs `ON UPDATE CASCADE`; `TutorSessionOutcome.planId` con `SET NULL`. `20261113191500_planificador_expand` aplicada; `20261112120000_user_profile_timezone` aplicada (faltaba en producción); `ebau_focus` marcada como aplicada sin reejecutarla. `prisma validate` y `tsc --noEmit` limpios; `migrate status` al día. | Nada de esquema; los defaults históricos siguen (1f). |
| 3. Motor puro | hecho | este commit | `src/lib/planner/engine.ts`: `capacityFor`, `score`, `pickBlocks` e `interleave`; sin Prisma, sin IA y sin `Date.now`. Capacidad al 70 %, energía 0.5/1/1.2, mínimo 10–15 min, 3–5 bloques, máximo 2 por materia y examen a 2 días por delante. `tsc` y `eslint` limpios. | Nada. |
| 4. Tests del motor | pendiente | — | — | — |
| 5. Orquestador `ensureTodayPlan` | pendiente | — | — | — |
| 6. `invalidatePlan` y disparadores | pendiente | — | — | — |
| 7. Entradas reales (`loadInputs`/`buildCandidates`/`toRow`) | pendiente | — | — | — |
| 8. UX del Cuartel | pendiente | — | — | — |
| 9. Restricciones y contexto del tutor | pendiente | — | — | — |
| 10. Cierre de sesión, corrector, foto y banco | pendiente | — | — | — |
| 11. B3 pedagogía activa | pendiente | — | — | — |
| 12. Verificación SymPy/unidades/química | pendiente | — | — | — |
| 13. Proactividad diaria | pendiente | — | — | — |
| 14. B7 modos por materia | pendiente | — | — | — |
| 15. Fase 0 de seguridad | pendiente (fuera del modo autónomo) | — | No ejecutar: RLS, `REVOKE`, rol `prisma_app`, secretos Moodle con AES-GCM y retry solo de lecturas. | Diseño en `PLAN.md`; se aborda en otra fase. |

Despliegue, publicación y `git push`: **fuera de alcance** del modo autónomo.

## Base de datos

- Host: `aws-0-eu-north-1.pooler.supabase.com`
- Runtime: puerto `6543` (pooler, `DATABASE_URL`); migraciones: puerto `5432` (`DIRECT_URL`), base `postgres`.
- Rol: `postgres.jwxatcbbauvlhufcfosa`. Es la base de producción; cualquier migración de esquema debe ser solo expand.
- Cuentas: `16bb4958-5288-493b-8c65-379dd31782f5` (autor, confirmada) y `3af632ee-22dc-4e75-85a8-139aa70600bf` (prueba, confirmada).

## Última verificación (2026-11-13)

- `npm run build`: exit 0 con el código actual.
- `/api/salud`: HTTP 200, `database.ok = true`; `/` → 307 a `/login`; `/login` 200; `/api/moodle/status` y `/api/planner` 401.
- `npx tsc --noEmit`: limpio antes de 1e; se repetirá al cerrar el paso 2.
- `npm run lint`: limpio antes de 1e.
- `npx prisma validate`: esquema válido.
- Recuentos post-1e: `UserProfile` 1, `_prisma_migrations` 2, 473 filas en el UUID del autor (471 migradas + 2 `SystemIssue` del vigilante creadas a las 19:05:36Z), 0 en la cuenta de prueba, 0 restos de `user_default`.
- Ensayo local: restauración con `--exit-on-error` y 26/26 tablas iguales; `migrate-user-id.js --apply` contra `127.0.0.1:55432/brainup_test`.
- Dump previo a 1e ignorado por git (`.gitignore:18`).
- `NODE_TLS_REJECT_UNAUTHORIZED=0` sigue en `.env` (riesgo conocido; no se toca sin confirmar).
- Supabase informa `disable_signup: false` en `/auth/v1/settings`; la app no expone registro, pero el toggle del proyecto no está desactivado.
