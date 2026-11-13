# PROGRESS — BrainUp Academy

Registro vivo. Cada fila se actualiza en el mismo commit que cierra su paso.
Estados: `pendiente`, `en curso`, `bloqueado`, `hecho`.

| Paso | Estado | Commit | Evidencia | Pendiente |
| --- | --- | --- | --- | --- |
| Docs (ENCARGO/PLAN/PROGRESS) | hecho | `e170cf3` | Los tres archivos existen y se commitean solos antes de seguir. | Sustituir `docs/ENCARGO.md` si el autor pega el texto literal. |
| 1. Identidad única Supabase | en curso | — | 1a: `d424a11`, `26518c3`, `2a2df35`; árbol limpio. 1b: `data/backups/brainup-pre-identity-20261112.dump` (510.970 B, dump custom PostgreSQL v1.16) y `data/backups/counts-pre-identity-20261112.json`. 1c: `src/proxy.ts` (401 en API, redirección a `/login`), `/login`, login solo con `signInWithPassword` (sin registro). 1d: `user_default` solo en migraciones históricas, comentarios y `@default` transitorios. Re-verificado 2026-11-13: `tsc --noEmit`, `npm run lint` y `prisma validate` limpios; preflight 24 tablas / 471 filas / 24 FKs con `ON UPDATE CASCADE`, 0 escrituras. | 1e y cierre, en parada obligatoria: falta la URL y la anon key de Supabase en `.env` (0 de 2), la cuenta real en `auth.users` (0 filas) y el "adelante" explícito. La base es el pooler de Supabase `aws-0-eu-north-1` (6543 runtime / 5432 directa): es la misma que producción, así que el paso 2 exige backup verificado y autorización aparte. |
| 2. Modelos de plan | pendiente | — | — | — |
| 3. Motor puro | pendiente | — | — | — |
| 4. Orquestador | pendiente | — | — | — |
| 5. Cuartel | pendiente | — | — | — |
| 6. Contexto del tutor | pendiente | — | — | — |
| 7. Corrector | pendiente | — | — | — |
| 8. Verificación SymPy/unidades/química | pendiente | — | — | — |
| 9. Cierre Parte A/B base | pendiente | — | — | — |
| 10. Despliegue controlado | pendiente | — | — | Autorización explícita del autor. |
| 11. B3 salidas persistentes | pendiente | — | — | — |
| 12. B5 foto manuscrita | pendiente | — | — | — |
| 13. B6 banco/MAE | pendiente | — | — | — |
| 14. B7 proactividad/modos | pendiente | — | — | — |

## Bloqueo actual

Parada obligatoria antes de 1e. `auth.users` tiene 0 filas y `.env` no contiene
`NEXT_PUBLIC_SUPABASE_URL` ni `NEXT_PUBLIC_SUPABASE_ANON_KEY`. No se ha tocado la
base.

Aviso: `.env` apunta al pooler de Supabase en `aws-0-eu-north-1` (6543 para
runtime, 5432 para `DIRECT_URL`), sobre la base `postgres` que contiene los datos
reales (471 filas). No es una base de desarrollo aparte: la migración 1e y
cualquier migración de esquema del paso 2 se ejecutarían sobre producción y
requieren autorización explícita.

## Última verificación (2026-11-13)

- `npx tsc --noEmit`: limpio.
- `npm run lint`: limpio.
- `npx prisma validate`: esquema válido.
- `pg_restore` no está instalado: el dump se validó por cabecera (`PostgreSQL
  custom database dump - v1.16-0`) y tamaño (510.970 B), no restaurándolo.
- `grep -RIn "user_default"`: solo migraciones históricas, comentarios y los
  `@default` transitorios del esquema.
- Preflight de `scripts/migrate-user-id.js` con UUID ficticio: 24 tablas, 471
  filas en `user_default`, 24 FKs con `ON UPDATE CASCADE`, 0 filas en destino.
