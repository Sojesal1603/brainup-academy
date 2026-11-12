# PROGRESS — BrainUp Academy

Registro vivo. Cada fila se actualiza en el mismo commit que cierra su paso.
Estados: `pendiente`, `en curso`, `bloqueado`, `hecho`.

| Paso | Estado | Commit | Evidencia | Pendiente |
| --- | --- | --- | --- | --- |
| Docs (ENCARGO/PLAN/PROGRESS) | hecho | `e170cf3` | Los tres archivos existen y se commitean solos antes de seguir. | Sustituir `docs/ENCARGO.md` si el autor pega el texto literal. |
| 1. Identidad única Supabase | en curso | — | 1a: `d424a11`, `26518c3`. 1b: `data/backups/brainup-pre-identity-20261112.dump` (499 KB, 66 tablas de datos) y `data/backups/counts-pre-identity-20261112.json`. 1c: `src/proxy.ts`, `/login`, rutas de auth, 401 de API. 1d: `grep` sin `user_default` en código/seed/scripts/SQL manual; `npx tsc --noEmit` y `npx prisma validate` limpios. 1e preparada: `scripts/migrate-user-id.js` en preflight (24 tablas, 471 filas, 24 FKs con `ON UPDATE CASCADE`), sin escribir. | 1e y cierre: falta la cuenta real en `auth.users` (0 filas) y las variables `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` en `.env`. Sin eso no se puede crear el usuario de prueba, migrar el UUID ni ejecutar el test de aislamiento. |
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

`auth.users` tiene 0 filas y `.env` no contiene variables de Supabase. El paso 1
no puede cerrarse hasta que exista la cuenta real y sus credenciales. No se ha
tocado la base para la migración 1e.

## Última verificación

- `npx tsc --noEmit`: limpio.
- `npx prisma validate`: esquema válido.
- `grep -RIn "user_default"`: solo migraciones históricas, comentarios y los
  `@default` transitorios del esquema.
