-- Fase 0 de seguridad: cerrar la API REST de Supabase a `anon` y `authenticated`.
--
-- Contexto medido antes de aplicarlo:
--   - Prisma conecta como `postgres`, que tiene `rolbypassrls = true` y es
--     propietario de las 29 tablas de `public`.
--   - `anon` y `authenticated` tenían SELECT/INSERT (y más) sobre todas ellas.
--   - No existía ninguna política RLS.
--
-- Esto NO crea políticas: con RLS activo y sin políticas, cualquier rol que no
-- sea propietario/BYPASSRLS queda denegado por defecto. Además se revocan los
-- privilegios, para que ni siquiera llegue a evaluar RLS.
--
-- No se toca `service_role` ni se crea `prisma_app` (eso es el paso 15).

BEGIN;

DO $$
DECLARE
  relation record;
BEGIN
  FOR relation IN
    SELECT n.nspname AS schema_name, c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', relation.schema_name, relation.table_name);
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM anon, authenticated', relation.schema_name, relation.table_name);
  END LOOP;
END
$$;

-- Las secuencias no deben poder incrementarse ni leerse sin pasar por la app.
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;

-- Las tablas futuras creadas por el propietario (`postgres`) nacen cerradas.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;

-- LÍMITE CONOCIDO: `supabase_admin` conserva sus propios default privileges con
-- anon/authenticated. `postgres` no es miembro de ese rol y no puede cambiarlos
-- (probado: «permission denied to change default privileges»). Las tablas que
-- cree el dashboard/Studio con ese rol habrá que cerrarlas desde Supabase o
-- volver a ejecutar este archivo. Las que crea Prisma (postgres) ya nacen
-- cerradas.

COMMIT;
