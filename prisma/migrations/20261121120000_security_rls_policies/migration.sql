-- Paso 15 · Fase 0 de seguridad: políticas RLS del rol de runtime.
--
-- Qué deja hecho (migración expand-only, sin borrar ni renombrar nada):
--   · RLS activa en todas las tablas de `public`, salvo `_prisma_migrations`
--     (no es dato de una cuenta y la app no debe verla).
--   · `anon` y `authenticated` sin privilegios. La revocación se repite aquí
--     para que una base nueva quede igual que producción.
--   · Una política para `prisma_app` en cada tabla:
--       - si la conexión ha fijado `app.user_id`, solo ve y escribe las filas
--         de esa cuenta (`userId`, o `id` en `UserProfile`);
--       - si no lo ha fijado, la política es permisiva. Es el modo de la
--         infraestructura que usa el cliente global: migraciones, vigilante,
--         arranque y tareas de mantenimiento. El aislamiento normal de la app
--         sigue siendo `db(userId)` (`src/lib/db.ts`), que fija el ajuste en
--         cada transacción.
--
-- La función `public.brainup_apply_app_rls()` es idempotente y se puede volver
-- a llamar después de añadir tablas nuevas. `prisma/sql/prisma_app.sql` la
-- invoca al crear el rol, así que el orden entre ambos archivos no importa.
--
-- No se aplica sola: queda pendiente de un `prisma migrate deploy` autorizado.
-- No contiene claves ni toca datos.

CREATE OR REPLACE FUNCTION public.brainup_apply_app_rls()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  relation record;
  has_prisma_app boolean;
  has_anon boolean;
  has_authenticated boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'prisma_app') INTO has_prisma_app;
  SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') INTO has_anon;
  SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') INTO has_authenticated;

  FOR relation IN
    SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND c.relname <> '_prisma_migrations'
    ORDER BY c.relname
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', relation.table_name);

    IF has_anon THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM anon', relation.table_name);
    END IF;
    IF has_authenticated THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM authenticated', relation.table_name);
    END IF;

    IF has_prisma_app THEN
      EXECUTE format('DROP POLICY IF EXISTS brainup_app_runtime ON public.%I', relation.table_name);

      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = relation.table_name
          AND column_name = 'userId'
      ) THEN
        EXECUTE format($fmt$
          CREATE POLICY brainup_app_runtime ON public.%I
          FOR ALL TO prisma_app
          USING (
            coalesce(current_setting('app.user_id', true), '') = ''
            OR "userId"::text = current_setting('app.user_id', true)
          )
          WITH CHECK (
            coalesce(current_setting('app.user_id', true), '') = ''
            OR "userId"::text = current_setting('app.user_id', true)
          )
        $fmt$, relation.table_name);
      ELSIF relation.table_name = 'UserProfile' THEN
        EXECUTE format($fmt$
          CREATE POLICY brainup_app_runtime ON public.%I
          FOR ALL TO prisma_app
          USING (
            coalesce(current_setting('app.user_id', true), '') = ''
            OR id::text = current_setting('app.user_id', true)
          )
          WITH CHECK (
            coalesce(current_setting('app.user_id', true), '') = ''
            OR id::text = current_setting('app.user_id', true)
          )
        $fmt$, relation.table_name);
      ELSE
        -- Tabla de infraestructura sin dueño por fila: el rol de servidor
        -- puede usarla, pero `anon` y `authenticated` siguen sin grants.
        EXECUTE format($fmt$
          CREATE POLICY brainup_app_runtime ON public.%I
          FOR ALL TO prisma_app
          USING (true)
          WITH CHECK (true)
        $fmt$, relation.table_name);
      END IF;
    END IF;
  END LOOP;

  IF has_anon THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM anon';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon';
  END IF;
  IF has_authenticated THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM authenticated';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM authenticated';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM authenticated';
  END IF;

  IF has_prisma_app THEN
    EXECUTE 'GRANT USAGE ON SCHEMA public TO prisma_app';
    EXECUTE 'REVOKE CREATE ON SCHEMA public FROM prisma_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO prisma_app';
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO prisma_app';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO prisma_app';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO prisma_app';

    IF to_regclass('public."_prisma_migrations"') IS NOT NULL THEN
      EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE public."_prisma_migrations" FROM prisma_app';
    END IF;
  END IF;
END;
$$;

-- Solo el dueño de las tablas (el rol que ejecuta las migraciones) necesita
-- poder invocar la función. `anon` y `authenticated` ni siquiera la ven.
REVOKE ALL ON FUNCTION public.brainup_apply_app_rls() FROM PUBLIC;

SELECT public.brainup_apply_app_rls();
