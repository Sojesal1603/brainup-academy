-- Rol de runtime `prisma_app` para BrainUp Academy.
--
-- Qué resuelve:
--   · La app no conecta con el rol dueño de la base (que puede hacer DDL,
--     borrar tablas o cambiar permisos). Si una inyección SQL o un error de
--     Prisma se escapa, el daño queda acotado a DML sobre las tablas.
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
--   PRISMA_APP_DATABASE_URL="postgresql://prisma_app:${app_password}@<pooler>:6543/brainup?pgbouncer=true&connection_limit=1&sslmode=require"
--
-- `DATABASE_URL` y `DIRECT_URL` no cambian: la primera es el respaldo del
-- runtime y la segunda la usa `prisma migrate deploy` con el rol dueño.
--
-- Este archivo no contiene ninguna clave real: la contraseña se pasa por
-- variable de psql y no se guarda en el repositorio.

\set ON_ERROR_STOP on

-- Se usa `\gexec` en vez de un DO: psql sustituye la variable fuera de las
-- comillas y `format(..., %L)` escapa la contraseña. Dentro de un bloque DO
-- dollar-quoted la sustitución no es fiable.
SELECT format('CREATE ROLE prisma_app LOGIN PASSWORD %L', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'prisma_app')
\gexec

SELECT format('ALTER ROLE prisma_app WITH LOGIN PASSWORD %L', :'app_password')
\gexec

-- Límites por rol: se aplican a toda conexión nueva de prisma_app, aunque la
-- cadena de conexión no lleve `options`. Es la forma fiable con pgbouncer,
-- donde los parámetros de sesión no se conservan entre transacciones.
ALTER ROLE prisma_app SET statement_timeout = '8s';
ALTER ROLE prisma_app SET idle_in_transaction_session_timeout = '10s';

-- Acceso a la base y al esquema.
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO prisma_app', current_database());
END
$$;

GRANT USAGE ON SCHEMA public TO prisma_app;

-- DML sobre lo que ya existe.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO prisma_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO prisma_app;

-- Y sobre lo que creen las próximas migraciones (ejecutadas por este mismo rol
-- dueño). Sin esto, cada tabla nueva nacería invisible para prisma_app.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO prisma_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO prisma_app;

-- Comprobación rápida: debe devolver el rol y sus dos límites.
SELECT rolname,
       rolconfig
FROM pg_roles
WHERE rolname = 'prisma_app';
