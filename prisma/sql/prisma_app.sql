-- Rol de runtime `prisma_app` para BrainUp Academy.
--
-- Qué resuelve:
--   · La app no conecta con el rol dueño de la base (que puede hacer DDL,
--     borrar tablas o cambiar permisos). Si una inyección SQL o un error de
--     Prisma se escapa, el daño queda acotado a DML sobre las tablas.
--   · `NOBYPASSRLS`: las políticas de la migración `security_rls_policies`
--     también se aplican a este rol, no solo a `anon`/`authenticated`.
--   · `statement_timeout = 8s`: una consulta no puede quedarse colgada
--     ocupando una conexión del pooler indefinidamente.
--   · `idle_in_transaction_session_timeout = 10s`: una transacción abierta y
--     olvidada no bloquea el proyecto entero. Encaja con el timeout de 10 s de
--     las transacciones de Prisma.
--
-- Cómo se ejecuta (NO con prisma_app, sino con el rol dueño de las tablas):
--
--   psql "$DIRECT_URL" \
--     -v app_password='una-clave-larga-y-solo-para-la-app' \
--     -f prisma/sql/prisma_app.sql
--
-- Después, en el entorno del servidor:
--
--   PRISMA_APP_DATABASE_URL="postgresql://prisma_app:${app_password}@<pooler>:6543/postgres?pgbouncer=true&connection_limit=1&sslmode=verify-full&sslaccept=strict&sslcert=prisma/certs/supabase-prod-ca-2021.crt"
--
-- `DATABASE_URL` y `DIRECT_URL` no cambian: la primera es el respaldo del
-- runtime y la segunda la usa `prisma migrate deploy` con el rol dueño.
--
-- Orden recomendado: primero `npx prisma migrate deploy` (crea la función
-- `public.brainup_apply_app_rls()` y las políticas), después este script. Si se
-- ejecuta al revés, el script deja el rol y los grants y avisa de que faltan
-- las políticas; la migración las aplica en cuanto se ejecute.
--
-- Este archivo no contiene ninguna clave real: la contraseña se pasa por
-- variable de psql y no se guarda en el repositorio.

\set ON_ERROR_STOP on

-- Sin contraseña no se crea un rol con una clave vacía o literal.
\if :{?app_password}
\else
  \warn 'Falta -v app_password=... (no se inventa ni se guarda una clave en el repo).'
  DO $$ BEGIN RAISE EXCEPTION 'app_password no definido'; END $$;
\endif

BEGIN;

-- Se usa `\gexec` en vez de un DO: psql sustituye la variable fuera de las
-- comillas y `format(..., %L)` escapa la contraseña. Dentro de un bloque DO
-- dollar-quoted la sustitución no es fiable.
SELECT format(
  'CREATE ROLE prisma_app LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
  :'app_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'prisma_app')
\gexec

-- Si el rol ya existía, se actualiza la clave y se dejan explícitos los
-- atributos: un rol creado a mano antes de este script no debe conservar
-- SUPERUSER ni BYPASSRLS.
SELECT format(
  'ALTER ROLE prisma_app WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
  :'app_password'
)
\gexec

-- Límites por rol: se aplican a toda conexión nueva de prisma_app, aunque la
-- cadena de conexión no lleve `options`. Es la forma fiable con pgbouncer,
-- donde los parámetros de sesión no se conservan entre transacciones.
ALTER ROLE prisma_app SET statement_timeout = '8s';
ALTER ROLE prisma_app SET idle_in_transaction_session_timeout = '10s';

-- Acceso a la base y al esquema. `REVOKE CREATE` es la parte que impide que la
-- app cree tablas, tipos o funciones incluso si una consulta se cuela.
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO prisma_app', current_database());
END
$$;

GRANT USAGE ON SCHEMA public TO prisma_app;
REVOKE CREATE ON SCHEMA public FROM prisma_app;

-- DML sobre lo que ya existe. Nada de TRUNCATE, REFERENCES ni TRIGGER.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO prisma_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO prisma_app;

-- La tabla de migraciones no es dato de una cuenta: la app no la lee ni la
-- escribe. Se revoca después del GRANT global a propósito.
DO $$
BEGIN
  IF to_regclass('public."_prisma_migrations"') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE public."_prisma_migrations" FROM prisma_app';
  END IF;
END
$$;

-- Y sobre lo que creen las próximas migraciones (ejecutadas por este mismo rol
-- dueño). Sin esto, cada tabla nueva nacería invisible para prisma_app.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO prisma_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO prisma_app;

-- Aplica (o reaplica) las políticas RLS a las tablas actuales. La función la
-- crea la migración `security_rls_policies`; si aún no está, se avisa y se
-- deja el rol listo para cuando se aplique.
DO $$
BEGIN
  IF to_regprocedure('public.brainup_apply_app_rls()') IS NOT NULL THEN
    PERFORM public.brainup_apply_app_rls();
  ELSE
    RAISE NOTICE 'prisma_app creado, pero falta la migración security_rls_policies: las políticas RLS se aplicarán al ejecutarla.';
  END IF;
END
$$;

COMMIT;

-- Comprobación rápida: debe devolver el rol, LOGIN, sin SUPERUSER/BYPASSRLS y
-- sus dos límites.
SELECT rolname,
       rolcanlogin,
       rolsuper,
       rolbypassrls,
       rolconfig
FROM pg_roles
WHERE rolname = 'prisma_app';
