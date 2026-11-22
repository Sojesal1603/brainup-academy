/**
 * Verificación del Paso 15 (Fase 0 de seguridad, parte segura).
 *
 * Modo normal (sin base de datos):
 *   node scripts/verify-security.js
 *
 *   · el script del rol exige contraseña, crea `prisma_app` sin SUPERUSER ni
 *     BYPASSRLS, le pone los dos timeouts, le quita DDL y no le da acceso a
 *     `_prisma_migrations`;
 *   · la migración activa RLS, revoca `anon`/`authenticated`, crea la política
 *     `brainup_app_runtime` y la limita a `app.user_id` cuando está fijado;
 *   · `db(userId).$transaction` fija `app.user_id` con `set_config(..., true)`
 *     antes del callback (y como primera consulta en la forma de lote);
 *   · el reintento de Prisma solo contiene lecturas (ni `upsert` ni escrituras);
 *   · el runtime prefiere `PRISMA_APP_DATABASE_URL` y la normaliza al pooler;
 *   · la contraseña de Moodle se cifra con el vault y contexto por cuenta, el
 *     formato antiguo del cifrador local se detecta para re-cifrarlo y la app
 *     ya no escribe secretos con la clave del equipo;
 *   · el SQL de `supabase_admin` cierra sus default privileges (se ejecuta
 *     aparte, como ese rol).
 *
 * Modo base de datos (Postgres local o una copia, NUNCA producción):
 *   BRAINUP_SECURITY_TEST_URL="postgresql://postgres:...@localhost:55433/brainup_test" \
 *     node scripts/verify-security.js --db
 *
 *   Requiere que la migración `security_rls_policies` y
 *   `prisma/sql/prisma_app.sql` ya se hayan aplicado en esa base de prueba.
 *   Crea dos cuentas y dos materias temporales, comprueba el aislamiento con
 *   `SET LOCAL ROLE prisma_app`, y las borra al terminar.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadEnv } = require('./lib/loadEnv');
const { compilaTs } = require('./lib/compilaTs');

loadEnv();

const ROOT = path.join(__dirname, '..');
const ROLE_SQL = path.join(ROOT, 'prisma', 'sql', 'prisma_app.sql');
const MIGRATION_DIR = path.join(
  ROOT,
  'prisma',
  'migrations',
  '20261121120000_security_rls_policies'
);
const MIGRATION_SQL = path.join(MIGRATION_DIR, 'migration.sql');

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const SUBJECT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SUBJECT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TENANT_SETTING = 'app.user_id';

let checks = 0;

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

async function ok(name, fn) {
  await fn();
  checks += 1;
  console.log(`  ✓ ${name}`);
}

function section(title) {
  console.log(`\n  ${title}`);
}

/** Quita los comentarios de línea: las comprobaciones negativas son de SQL. */
function sentencias(sql) {
  return sql.replace(/--.*$/gm, '');
}

function assertNoRawBypass(sql) {
  // Los comentarios explican «sin SUPERUSER/BYPASSRLS»; solo cuentan las
  // sentencias. Después se quitan los prefijos NO... para buscar el atributo
  // positivo (BYPASSRLS o SUPERUSER a secas).
  const sinPrefijos = sentencias(sql)
    .replace(/NOBYPASSRLS/g, '')
    .replace(/NOSUPERUSER/g, '');
  assert.doesNotMatch(sinPrefijos, /\bBYPASSRLS\b/, 'el rol no debe poder saltarse RLS');
  assert.doesNotMatch(sinPrefijos, /\bSUPERUSER\b/, 'el rol no debe ser superusuario');
}

async function verifyStatic() {
  const role = read(ROLE_SQL);
  const migration = read(MIGRATION_SQL);
  const dbSource = read(path.join(ROOT, 'src', 'lib', 'db.ts'));
  const prismaSource = read(path.join(ROOT, 'src', 'lib', 'prisma.ts'));

  section('Rol prisma_app');

  await ok('exige la contraseña por variable y no la guarda en el repo', () => {
    assert.match(role, /\\if :\{\?app_password\}/);
    assert.match(role, /RAISE EXCEPTION 'app_password no definido'/);
    assert.doesNotMatch(role, /PASSWORD '(?!%L)[^']*'/);
  });

  await ok('crea un rol LOGIN sin SUPERUSER ni BYPASSRLS', () => {
    assert.match(role, /CREATE ROLE prisma_app LOGIN PASSWORD %L/);
    assert.match(role, /NOSUPERUSER/);
    assert.match(role, /NOBYPASSRLS/);
    assertNoRawBypass(role);
  });

  await ok('aplica statement_timeout e idle_in_transaction_session_timeout', () => {
    assert.match(role, /ALTER ROLE prisma_app SET statement_timeout = '8s'/);
    assert.match(
      role,
      /ALTER ROLE prisma_app SET idle_in_transaction_session_timeout = '10s'/
    );
  });

  await ok('solo concede DML y le quita CREATE en el esquema', () => {
    assert.match(role, /GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES/);
    assert.match(role, /REVOKE CREATE ON SCHEMA public FROM prisma_app/);
    assert.doesNotMatch(sentencias(role), /GRANT ALL/);
    assert.doesNotMatch(sentencias(role), /\bTRUNCATE\b/);
  });

  await ok('excluye _prisma_migrations del acceso de la app', () => {
    assert.match(
      role,
      /REVOKE ALL PRIVILEGES ON TABLE public\."_prisma_migrations" FROM prisma_app/
    );
  });

  await ok('aplica las políticas RLS si la migración ya existe', () => {
    assert.match(role, /to_regprocedure\('public\.brainup_apply_app_rls\(\)'\)/);
    assert.match(role, /PERFORM public\.brainup_apply_app_rls\(\)/);
  });

  section('Migración RLS');

  await ok('activa RLS y revoca anon/authenticated en todas las tablas', () => {
    assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
    assert.match(migration, /REVOKE ALL PRIVILEGES ON TABLE public\.%I FROM anon/);
    assert.match(
      migration,
      /REVOKE ALL PRIVILEGES ON TABLE public\.%I FROM authenticated/
    );
    assert.doesNotMatch(sentencias(migration), /DISABLE ROW LEVEL SECURITY/);
  });

  await ok('crea una política para prisma_app y es idempotente', () => {
    assert.match(migration, /CREATE POLICY brainup_app_runtime/);
    assert.match(migration, /DROP POLICY IF EXISTS brainup_app_runtime/);
    assert.match(migration, /CREATE OR REPLACE FUNCTION public\.brainup_apply_app_rls\(\)/);
  });

  await ok('limita la política a la cuenta fijada en app.user_id', () => {
    assert.match(migration, new RegExp(`current_setting\\('${TENANT_SETTING}', true\\)`));
    assert.match(migration, /"userId"::text = current_setting/);
    assert.match(migration, /id::text = current_setting/);
    assert.match(migration, /coalesce\(current_setting\('app\.user_id', true\), ''\) = ''/);
  });

  await ok('deja _prisma_migrations fuera del bucle y sin grants', () => {
    assert.match(migration, /c\.relname <> '_prisma_migrations'/);
    assert.match(
      migration,
      /REVOKE ALL PRIVILEGES ON TABLE public\."_prisma_migrations" FROM prisma_app/
    );
  });

  await ok('no borra datos ni tablas y no deja la función a PUBLIC', () => {
    assert.doesNotMatch(sentencias(migration), /\bDROP TABLE\b/);
    assert.doesNotMatch(sentencias(migration), /\bTRUNCATE\b/);
    assert.doesNotMatch(sentencias(migration), /\bDELETE FROM\b/);
    assert.match(
      migration,
      /REVOKE ALL ON FUNCTION public\.brainup_apply_app_rls\(\) FROM PUBLIC/
    );
  });

  section('Runtime');

  await ok('db() fija la cuenta con set_config(..., true) en la transacción', () => {
    assert.match(dbSource, new RegExp(`TENANT_SETTING = '${TENANT_SETTING}'`));
    const fijados = dbSource.match(/set_config\('\$\{TENANT_SETTING\}', \$1, true\)/g) || [];
    assert.ok(fijados.length >= 2, 'faltan el camino interactivo o el de lote');
    assert.match(dbSource, /await setTenantContext\(tx, ownerId\)/);
    assert.match(dbSource, /start\(\[context, \.\.\.\(input as unknown\[\]\)\], options\)/);
    assert.match(dbSource, /withTransactionFlag/);
  });

  await ok('el reintento de Prisma solo incluye lecturas', () => {
    const bloque = prismaSource.match(
      /const RETRYABLE_OPERATIONS[\s\S]*?new Set\(\[([\s\S]*?)\]\);/
    );
    assert.ok(bloque, 'no se encuentra RETRYABLE_OPERATIONS');
    const operaciones = [...bloque[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(
      operaciones.sort(),
      [
        'aggregate',
        'count',
        'findFirst',
        'findFirstOrThrow',
        'findMany',
        'findUnique',
        'findUniqueOrThrow',
        'groupBy',
      ].sort()
    );
    assert.ok(!operaciones.includes('upsert'), 'upsert es una escritura');
  });

  await ok('el cliente acotado no reintenta dentro de una transacción', () => {
    assert.match(prismaSource, /const NO_RETRIES: readonly number\[\] = \[\]/);
    assert.match(prismaSource, /isInTransaction\(\) \? NO_RETRIES : DB_RETRY_DELAYS_MS/);
  });

  section('Secretos de Moodle');

  await ok('la contraseña de Moodle se cifra con el vault y contexto por cuenta', () => {
    const outDir = compilaTs('moodleSecrets', '.tmp-verify-security-moodle');
    const secrets = require(path.join(outDir, 'moodleSecrets.js'));
    const previous = process.env.SECRETS_KEY_V1;
    process.env.SECRETS_KEY_V1 = Buffer.alloc(32, 0x2a).toString('base64');

    try {
      const password = 'ClaveDelInstituto-2026!';
      const sealed = secrets.sealMoodlePassword(TENANT_A, password);
      assert.match(sealed, /^v1\./);
      assert.notStrictEqual(
        sealed,
        secrets.sealMoodlePassword(TENANT_A, password),
        'el IV debe ser aleatorio'
      );

      const own = secrets.readMoodlePassword(TENANT_A, sealed);
      assert.strictEqual(own.password, password);
      assert.strictEqual(own.needsReseal, false);

      const other = secrets.readMoodlePassword(TENANT_B, sealed);
      assert.strictEqual(other.password, null, 'otra cuenta no debe poder leerlo');
      assert.strictEqual(other.unreadable, true);

      const tampered = `${sealed.slice(0, -4)}AAAA`;
      assert.strictEqual(secrets.readMoodlePassword(TENANT_A, tampered).password, null);
    } finally {
      if (previous === undefined) delete process.env.SECRETS_KEY_V1;
      else process.env.SECRETS_KEY_V1 = previous;
    }
  });

  await ok('el formato antiguo se detecta para re-cifrarlo', () => {
    const outDir = compilaTs('moodleSecrets', '.tmp-verify-security-moodle');
    const secrets = require(path.join(outDir, 'moodleSecrets.js'));

    assert.strictEqual(secrets.sealedFormat('v1.a.b.c'), 'vault');
    assert.strictEqual(secrets.sealedFormat('v1:aaaa:bbbb:cccc'), 'legacy');
    assert.strictEqual(secrets.sealedFormat('sin-formato'), 'unknown');
    assert.strictEqual(secrets.sealedFormat(null), 'unknown');

    // Un valor antiguo ilegible no rompe nada: se trata como «no hay».
    const garbage = secrets.readMoodlePassword(TENANT_A, 'v1:aaaa:bbbb:cccc');
    assert.strictEqual(garbage.password, null);
    assert.strictEqual(garbage.unreadable, true);
    assert.strictEqual(garbage.needsReseal, false);
  });

  await ok('la app ya no escribe secretos con la clave del equipo', () => {
    const localSource = read(path.join(ROOT, 'src', 'lib', 'localSecrets.ts'));
    const authSource = read(path.join(ROOT, 'src', 'lib', 'moodleAuth.ts'));

    assert.doesNotMatch(localSource, /export function sealSecret/);
    assert.doesNotMatch(localSource, /writeFileSync/);
    assert.match(localSource, /export function openLegacySecret/);

    assert.match(authSource, /sealMoodlePassword/);
    assert.match(authSource, /readMoodlePassword/);
    assert.doesNotMatch(authSource, /sealSecret|openSecret\b/);

    // La clave del cifrador antiguo estuvo versionada por error: no puede
    // volver al índice de git.
    const gitignore = read(path.join(ROOT, '.gitignore'));
    assert.match(gitignore, /data\/\.clave-local/, 'la clave local debe estar ignorada');
  });

  await ok('el SQL de supabase_admin cierra sus default privileges', () => {
    const sql = read(path.join(ROOT, 'prisma', 'sql', 'supabase_admin_defaults.sql'));

    assert.match(
      sql,
      /ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON TABLES FROM %I/
    );
    assert.match(sql, /pg_has_role\(current_user, 'supabase_admin', 'MEMBER'\)/);
    assert.doesNotMatch(sentencias(sql), /GRANT ALL/);
    assert.doesNotMatch(sentencias(sql), /\bTRUNCATE\b/);
    assert.doesNotMatch(sentencias(sql), /\bDELETE FROM\b/);
  });

  section('URL de runtime');

  await ok('prefiere PRISMA_APP_DATABASE_URL y normaliza el pooler', () => {
    const outDir = compilaTs('databaseDiagnostics', '.tmp-verify-security');
    const diag = require(path.join(outDir, 'databaseDiagnostics.js'));

    process.env.PRISMA_APP_DATABASE_URL =
      'postgresql://prisma_app:secreto@aws-0-eu-north-1.pooler.supabase.com:5432/postgres';
    process.env.DATABASE_URL =
      'postgresql://postgres:secreto@db.ejemplo.supabase.co:5432/postgres';

    const url = new URL(diag.resolveRuntimeDatabaseUrl());
    assert.equal(url.username, 'prisma_app');
    assert.equal(url.hostname, 'aws-0-eu-north-1.pooler.supabase.com');
    assert.equal(url.port, '6543');
    assert.equal(url.searchParams.get('pgbouncer'), 'true');
    assert.ok(url.searchParams.get('connection_limit'));

    const target = diag.databaseTarget();
    assert.equal(target.dedicatedRole, true);
    assert.equal(target.role, 'prisma_app');

    delete process.env.PRISMA_APP_DATABASE_URL;
    const fallback = new URL(diag.resolveRuntimeDatabaseUrl());
    assert.equal(fallback.username, 'postgres');
    assert.equal(diag.databaseTarget().dedicatedRole, false);
  });

  await ok('la migración está en el árbol de Prisma', () => {
    assert.ok(fs.existsSync(MIGRATION_SQL), 'falta la migración');
    assert.ok(fs.existsSync(ROLE_SQL), 'falta el script del rol');
  });
}

async function runAs(prisma, role, userId, fn) {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
      if (userId) {
        await tx.$executeRawUnsafe(
          `SELECT set_config('${TENANT_SETTING}', $1, true)`,
          userId
        );
      }
      return fn(tx);
    },
    { timeout: 15_000 }
  );
}

async function verifyDatabase() {
  const url = (process.env.BRAINUP_SECURITY_TEST_URL || '').trim();
  if (!url) {
    throw new Error(
      'Falta BRAINUP_SECURITY_TEST_URL. Usa una base local o una copia; nunca producción.'
    );
  }

  const host = new URL(url).hostname;
  if (host.endsWith('supabase.co') || host.endsWith('pooler.supabase.com')) {
    throw new Error(
      `La verificación con --db no se ejecuta contra Supabase (${host}). Usa un Postgres local.`
    );
  }

  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient({ datasources: { db: { url } } });

  try {
    section(`Base de datos de prueba (${host})`);

    await prisma.subject.deleteMany({ where: { id: { in: [SUBJECT_A, SUBJECT_B] } } });
    await prisma.userProfile.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
    await prisma.userProfile.createMany({
      data: [
        { id: TENANT_A, name: 'Cuenta A', updatedAt: new Date() },
        { id: TENANT_B, name: 'Cuenta B', updatedAt: new Date() },
      ],
    });
    await prisma.subject.createMany({
      data: [
        { id: SUBJECT_A, userId: TENANT_A, name: 'Materia A' },
        { id: SUBJECT_B, userId: TENANT_B, name: 'Materia B' },
      ],
    });

    await ok('prisma_app existe, puede entrar y no puede saltarse RLS', async () => {
      const [role] = await prisma.$queryRawUnsafe(
        `SELECT rolcanlogin, rolsuper, rolbypassrls, rolconfig
           FROM pg_roles WHERE rolname = 'prisma_app'`
      );
      assert.ok(role, 'falta el rol prisma_app');
      assert.equal(role.rolcanlogin, true);
      assert.equal(role.rolsuper, false);
      assert.equal(role.rolbypassrls, false);
      const config = (role.rolconfig || []).join(',');
      assert.match(config, /statement_timeout=8s/);
      assert.match(config, /idle_in_transaction_session_timeout=10s/);

      const [privileges] = await prisma.$queryRawUnsafe(
        `SELECT has_database_privilege('prisma_app', current_database(), 'CONNECT') AS connect,
                has_schema_privilege('prisma_app', 'public', 'CREATE') AS can_create,
                has_table_privilege('prisma_app', 'public."_prisma_migrations"', 'SELECT') AS migrations
        `
      );
      assert.equal(privileges.connect, true);
      assert.equal(privileges.can_create, false);
      assert.equal(privileges.migrations, false);
    });

    await ok('RLS está activa y hay una política por tabla de usuario', async () => {
      const [rls] = await prisma.$queryRawUnsafe(
        `SELECT count(*)::int AS tables
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r'
            AND c.relrowsecurity AND c.relname <> '_prisma_migrations'`
      );
      const [policies] = await prisma.$queryRawUnsafe(
        `SELECT count(*)::int AS policies FROM pg_policies
          WHERE schemaname = 'public' AND policyname = 'brainup_app_runtime'`
      );
      assert.ok(rls.tables >= 30, `solo ${rls.tables} tablas con RLS`);
      assert.equal(policies.policies, rls.tables);
    });

    await ok('sin app.user_id, el rol de servidor ve la infraestructura', async () => {
      const rows = await runAs(prisma, 'prisma_app', null, (tx) =>
        tx.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "Subject"`)
      );
      assert.equal(rows[0].n, 2);
    });

    await ok('con app.user_id, solo ve las filas de esa cuenta', async () => {
      const rows = await runAs(prisma, 'prisma_app', TENANT_A, async (tx) => {
        const subjects = await tx.$queryRawUnsafe(
          `SELECT count(*)::int AS n FROM "Subject"`
        );
        const profiles = await tx.$queryRawUnsafe(
          `SELECT count(*)::int AS n FROM "UserProfile"`
        );
        return { subjects: subjects[0].n, profiles: profiles[0].n };
      });
      assert.equal(rows.subjects, 1);
      assert.equal(rows.profiles, 1);
    });

    await ok('con app.user_id, no puede leer ni escribir otra cuenta', async () => {
      const seen = await runAs(prisma, 'prisma_app', TENANT_A, (tx) =>
        tx.$queryRawUnsafe(
          `SELECT count(*)::int AS n FROM "Subject" WHERE "userId" = $1`,
          TENANT_B
        )
      );
      assert.equal(seen[0].n, 0);

      await assert.rejects(
        () =>
          runAs(prisma, 'prisma_app', TENANT_A, (tx) =>
            tx.$executeRawUnsafe(
              `INSERT INTO "Subject" (id, "userId", name)
               VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', $1, 'Intruso')`,
              TENANT_B
            )
          ),
        /row-level security|violat/i
      );
    });

    await ok('anon y authenticated no pueden leer ni escribir', async () => {
      for (const role of ['anon', 'authenticated']) {
        const [grants] = await prisma.$queryRawUnsafe(
          `SELECT count(*)::int AS n FROM information_schema.role_table_grants
            WHERE table_schema = 'public' AND grantee = $1`,
          role
        );
        assert.equal(grants.n, 0, `${role} conserva grants`);

        await assert.rejects(
          () =>
            runAs(prisma, role, null, (tx) =>
              tx.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "Subject"`)
            ),
          /permission denied/i
        );
      }
    });

    await ok('prisma_app no puede hacer DDL ni leer _prisma_migrations', async () => {
      await assert.rejects(
        () =>
          runAs(prisma, 'prisma_app', null, (tx) =>
            tx.$executeRawUnsafe('CREATE TABLE no_deberia_existir (id int)')
          ),
        /permission denied/i
      );

      await assert.rejects(
        () =>
          runAs(prisma, 'prisma_app', null, (tx) =>
            tx.$queryRawUnsafe('SELECT count(*)::int AS n FROM "_prisma_migrations"')
          ),
        /permission denied/i
      );
    });

    const appUrl = (process.env.BRAINUP_SECURITY_TEST_APP_URL || '').trim();
    if (appUrl) {
      await ok('db(userId) fija app.user_id en las dos formas de $transaction', async () => {
        // El módulo real de la app, conectado con el rol prisma_app. Se fija la
        // URL antes de compilar/require para que el singleton no caiga en
        // DATABASE_URL (que en .env es producción).
        process.env.PRISMA_APP_DATABASE_URL = appUrl;
        const outDir = compilaTs('db', '.tmp-verify-security-db');
        const { db } = require(path.join(outDir, 'db.js'));
        const scoped = db(TENANT_A);

        try {
          const interactive = await scoped.$transaction(async (tx) =>
            tx.subject.findMany({ select: { id: true } })
          );
          assert.deepEqual(
            interactive.map((row) => row.id),
            [SUBJECT_A],
            'la transacción interactiva no ve solo la cuenta A'
          );

          const cross = await scoped.$transaction(async (tx) =>
            tx.$queryRawUnsafe(
              `SELECT count(*)::int AS n FROM "Subject" WHERE "userId" = $1`,
              TENANT_B
            )
          );
          assert.equal(cross[0].n, 0, 'el SQL crudo de la transacción vio otra cuenta');

          // El wrapper antepone el `set_config`, así que el resultado del lote
          // trae primero el número de filas del ajuste y después el del modelo.
          const [, batch] = await scoped.$transaction([
            scoped.subject.findMany({ select: { id: true } }),
          ]);
          assert.deepEqual(
            batch.map((row) => row.id),
            [SUBJECT_A],
            'la transacción en lote no ve solo la cuenta A'
          );
        } finally {
          await scoped.$disconnect().catch(() => undefined);
        }
      });
    }
  } finally {
    await prisma.subject
      .deleteMany({ where: { id: { in: [SUBJECT_A, SUBJECT_B] } } })
      .catch(() => undefined);
    await prisma.userProfile
      .deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } })
      .catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
  }
}

(async () => {
  console.log('\n  Paso 15 · seguridad del rol de runtime\n');

  await verifyStatic();
  if (process.argv.includes('--db')) {
    await verifyDatabase();
  } else {
    console.log(
      '\n  (Sin --db: no se ha tocado ninguna base de datos. Para la prueba real, usa una copia local.)\n'
    );
  }

  console.log(`\n  ${checks} comprobaciones en verde.\n`);
})().catch((error) => {
  console.error(`\n  ✗ ${error.message}\n`);
  process.exitCode = 1;
});
