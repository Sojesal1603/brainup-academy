-- Default privileges de `supabase_admin` en `public`.
--
-- Por qué hace falta un archivo aparte:
--   · `20261121120000_security_rls_policies` revoca los default privileges del
--     rol que ejecuta las migraciones (`postgres`), que es el dueño de las 30
--     tablas. Con eso, una tabla nueva creada por Prisma nace cerrada.
--   · Pero Supabase trae `supabase_admin`, un rol del que `postgres` no es
--     miembro. Sus default privileges siguen concediendo privilegios a `anon` y
--     `authenticated`: cualquier objeto que cree ESE rol nacería abierto, aunque
--     la app no lo use. `postgres` no puede cambiarlos («permission denied to
--     change default privileges»).
--
-- Este script se ejecuta **como `supabase_admin`** (o como un rol miembro), una
-- sola vez. Es idempotente: repetirlo no cambia nada.
--
--   psql "$DIRECT_URL_SUPABASE_ADMIN" -f prisma/sql/supabase_admin_defaults.sql
--
-- No borra tablas, no cambia datos y no toca las políticas de las tablas que ya
-- existen (eso lo hace `brainup_apply_app_rls()`). Si `supabase_admin` fuera
-- dueño de alguna tabla, ejecuta también:
--
--   SELECT public.brainup_apply_app_rls();
--
-- como ese rol, para que sus políticas se reapliquen.

\set ON_ERROR_STOP on

DO $$
DECLARE
  grantee_name text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    RAISE NOTICE 'No existe el rol supabase_admin en esta base: no hay nada que cerrar.';
    RETURN;
  END IF;

  IF NOT pg_has_role(current_user, 'supabase_admin', 'MEMBER') THEN
    RAISE EXCEPTION
      'Ejecuta este script como supabase_admin (o con un rol miembro de él): el rol actual es %.',
      current_user;
  END IF;

  FOREACH grantee_name IN ARRAY ARRAY['anon', 'authenticated']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = grantee_name) THEN
      RAISE NOTICE 'El rol % no existe: se omite.', grantee_name;
      CONTINUE;
    END IF;

    -- Objetos que cree supabase_admin a partir de ahora en `public`.
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON TABLES FROM %I',
      grantee_name
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I',
      grantee_name
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I',
      grantee_name
    );

    RAISE NOTICE 'Default privileges de supabase_admin cerrados para % en public.', grantee_name;
  END LOOP;
END
$$;

-- Comprobación: no debe quedar ninguna fila que conceda algo a anon o
-- authenticated para objetos creados por supabase_admin en public.
SELECT
  pg_get_userbyid(d.defaclrole) AS owner_role,
  n.nspname AS schema,
  d.defaclobjtype AS object_type,
  CASE d.defaclobjtype
    WHEN 'r' THEN 'tablas'
    WHEN 'S' THEN 'secuencias'
    WHEN 'f' THEN 'funciones'
    ELSE d.defaclobjtype::text
  END AS kind,
  d.defaclacl AS acl
FROM pg_default_acl d
LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
WHERE pg_get_userbyid(d.defaclrole) = 'supabase_admin'
ORDER BY n.nspname, d.defaclobjtype;
