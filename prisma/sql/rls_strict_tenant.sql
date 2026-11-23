-- RLS estricta por cuenta (fail-closed) para el rol de runtime `prisma_app`.
--
-- POR QUÉ EXISTE ESTE ARCHIVO Y NO ES UNA MIGRACIÓN AUTOMÁTICA
-- ------------------------------------------------------------
-- La migración `20261121120000_security_rls_policies` escribió una política que
-- **deja pasar todo cuando `app.user_id` no está fijado**:
--
--   coalesce(current_setting('app.user_id', true), '') = ''
--   OR "userId"::text = current_setting('app.user_id', true)
--
-- Esa rama era para la infraestructura (scripts, cierres nocturnos) que usa el
-- cliente global de Prisma. El efecto secundario es que RLS no protege ninguna
-- consulta suelta: solo las que van dentro de `db(userId).$transaction`, que es
-- el único sitio donde el código fija el ajuste. Si una ruta, un `$queryRaw` o
-- una tabla nueva se salta la extensión de Prisma, RLS no la detiene.
--
-- Este archivo la vuelve fail-closed: sin ajuste, no hay filas. No se aplica
-- sola porque, en el mismo instante en que se aplica, cualquier código que no
-- fije `app.user_id` deja de ver datos. El despliegue es en dos pasos:
--
--   1. Desplegar el código con `TENANT_RLS_STRICT=1` y `PRISMA_APP_DATABASE_URL`
--      (rol `prisma_app`, NO el dueño de las tablas). En ese modo, CADA consulta
--      de `db(userId)` va en una transacción con `SET LOCAL app.user_id`, y
--      `withTransaction(..., { tenantId })` hace lo mismo en las transacciones
--      globales que tocan datos de una cuenta.
--   2. Ejecutar este archivo contra la base:
--        psql "$DIRECT_URL" -f prisma/sql/rls_strict_tenant.sql
--
-- Comprobación después de aplicarlo (debe devolver 0 y luego ≥ 1):
--   SELECT count(*) FROM "Note";                        -- como prisma_app, sin ajuste
--   BEGIN; SELECT set_config('app.user_id', '<uuid>', true);
--   SELECT count(*) FROM "Note"; COMMIT;                -- como prisma_app, con ajuste
--
-- DESHACER (volver al modo permisivo, p. ej. durante un rollback):
--   SELECT public.brainup_revert_app_rls();
--
-- NOTA SOBRE ROLES: las políticas se crean para `prisma_app`. Si la app conecta
-- con el dueño de las tablas o con `postgres` (superusuario), PostgreSQL ignora
-- RLS y este archivo no sirve de nada; por eso el código se niega a arrancar con
-- `TENANT_RLS_STRICT=1` si falta `PRISMA_APP_DATABASE_URL`.

CREATE OR REPLACE FUNCTION public.brainup_apply_app_rls_strict()
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

  IF NOT has_prisma_app THEN
    -- Sin el rol de runtime no hay a quién aplicar la política. Fallar aquí es
    -- mejor que dejar la base con RLS a medias y creer que está protegida.
    RAISE EXCEPTION 'Falta el rol prisma_app: ejecuta antes prisma/sql/prisma_app.sql';
  END IF;

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
    -- FORCE hace que también el DUEÑO de la tabla esté sujeto a las políticas.
    -- Un superusuario (postgres) sigue saltándolas: no es una puerta trasera
    -- accidental, es cómo funciona PostgreSQL.
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', relation.table_name);

    IF has_anon THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM anon', relation.table_name);
    END IF;
    IF has_authenticated THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM authenticated', relation.table_name);
    END IF;

    EXECUTE format('DROP POLICY IF EXISTS brainup_app_runtime ON public.%I', relation.table_name);

    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = relation.table_name
        AND column_name = 'userId'
    ) THEN
      -- Sin `coalesce(..., '') = ''`: si el ajuste no está fijado, la comparación
      -- es NULL y la fila NO pasa. Ese es el cambio que convierte RLS en una
      -- segunda capa real.
      EXECUTE format($fmt$
        CREATE POLICY brainup_app_runtime ON public.%I
        FOR ALL TO prisma_app
        USING ("userId"::text = current_setting('app.user_id', true))
        WITH CHECK ("userId"::text = current_setting('app.user_id', true))
      $fmt$, relation.table_name);
    ELSIF relation.table_name = 'UserProfile' THEN
      EXECUTE format($fmt$
        CREATE POLICY brainup_app_runtime ON public.%I
        FOR ALL TO prisma_app
        USING (id::text = current_setting('app.user_id', true))
        WITH CHECK (id::text = current_setting('app.user_id', true))
      $fmt$, relation.table_name);
    ELSE
      -- Tabla de infraestructura sin dueño por fila. Antes era `USING (true)`
      -- (cualquiera con el rol la veía entera). Ahora queda cerrada al runtime:
      -- si alguna tabla de datos acaba aquí, es un fallo de diseño que hay que
      -- ver en el aviso, no una fuga silenciosa.
      RAISE WARNING 'brainup: la tabla % no tiene userId; RLS la cierra al runtime',
        relation.table_name;
      EXECUTE format($fmt$
        CREATE POLICY brainup_app_runtime ON public.%I
        FOR ALL TO prisma_app
        USING (false)
        WITH CHECK (false)
      $fmt$, relation.table_name);
    END IF;
  END LOOP;

  EXECUTE 'GRANT USAGE ON SCHEMA public TO prisma_app';
  EXECUTE 'REVOKE CREATE ON SCHEMA public FROM prisma_app';
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO prisma_app';
  EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO prisma_app';
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO prisma_app';
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO prisma_app';

  IF to_regclass('public."_prisma_migrations"') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE public."_prisma_migrations" FROM prisma_app';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.brainup_apply_app_rls_strict() FROM PUBLIC;

-- Vuelta atrás: quita FORCE y restaura las políticas permisivas anteriores
-- (`SELECT public.brainup_apply_app_rls()` sigue existiendo en la base).
CREATE OR REPLACE FUNCTION public.brainup_revert_app_rls()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  relation record;
BEGIN
  FOR relation IN
    SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND c.relname <> '_prisma_migrations'
    ORDER BY c.relname
  LOOP
    EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', relation.table_name);
  END LOOP;

  PERFORM public.brainup_apply_app_rls();
END;
$$;

REVOKE ALL ON FUNCTION public.brainup_revert_app_rls() FROM PUBLIC;

SELECT public.brainup_apply_app_rls_strict();
