#!/usr/bin/env node
/**
 * Despliegue maestro: comprueba, verifica y (solo si se pide) aplica.
 *
 * El orden importa. Este repositorio tiene una regla que se ha roto una vez y no
 * puede romperse otra: **primero el esquema, después el código**. `updateNote`
 * consulta `NoteSection` en cada guardado de apunte, así que si el build nuevo
 * sale antes que la migración `study_sources_and_modular_notes`, el cuaderno
 * entero empieza a responder 500 (P2021). Netlify solo ejecuta `npm run build`:
 * no migra nada por su cuenta. Este script es la secuencia que faltaba.
 *
 * Qué hace, en orden:
 *   1. Entorno: variables, tipos de URL, schema válido y auditoría de las
 *      migraciones del repositorio (busca sentencias que pierdan datos).
 *   2. Base de datos: `prisma migrate status` (pendientes y fallidas), tablas
 *      clave, pgvector y desajustes conocidos.
 *   3. RLS y roles: RLS activa, política `brainup_app_runtime`, grants de
 *      `anon`/`authenticated`, atributos de `prisma_app` y si las políticas son
 *      permisivas o fail-closed.
 *   4. Verificación: `tsc --noEmit`, `verify:lienzo`, `verify:security`,
 *      `verify:stages`, `verify:materias` (y `lint` + `build` con `--build`).
 *   5. Despliegue, SOLO con `--aplicar`: `prisma migrate deploy` con puerta de
 *      copia de seguridad y recomprobación posterior. Aquí no se despliega el
 *      código de la app: eso lo hace Netlify.
 *
 * Uso:
 *   npm run despliegue:check                 # auditoría completa, no escribe nada
 *   npm run despliegue:check -- --solo-codigo  # sin tocar la base (CI, revisión)
 *   npm run despliegue:aplicar               # audita y, si está verde, migra
 *   npm run despliegue:completo              # audita, migra y compila el build
 *
 * Banderas:
 *   --solo-codigo      no abre conexión a la base (omite los pasos 2 y 3)
 *   --aplicar          ejecuta `prisma migrate deploy` si todo está en verde
 *   --build            añade `npm run lint` y `npm run build`
 *   --sin-backup       permite migrar sin un dump reciente en data/backups/
 *   --estricto         exige el rol prisma_app y políticas RLS fail-closed
 *   --ayuda            muestra esta ayuda
 *
 * Códigos de salida: 0 = sin bloqueos (puede haber avisos), 1 = no desplegar.
 *
 * REGLA: salvo `--aplicar`, todas las consultas son SELECT. Ni un INSERT, ni un
 * DDL, ni una llamada a `brainup_apply_app_rls()`. La contraseña de la base no
 * se imprime nunca: solo host, puerto, base y rol.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadEnv } = require('./lib/loadEnv');

loadEnv();

const ROOT = path.join(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'prisma', 'migrations');
const BACKUPS_DIR = path.join(ROOT, 'data', 'backups');

const flags = new Set(process.argv.slice(2).filter((arg) => arg.startsWith('--')));
const SOLO_CODIGO = flags.has('--solo-codigo');
const APLICAR = flags.has('--aplicar') || flags.has('--deploy');
const CON_BUILD = flags.has('--build');
const SIN_BACKUP = flags.has('--sin-backup');
const ESTRICTO = flags.has('--estricto');
const AYUDA = flags.has('--ayuda') || flags.has('--help');

/**
 * Tablas que la app necesita para funcionar. Si falta una, el build nuevo
 * responde P2021 en cuanto alguien abre el cuaderno (o guarda un apunte).
 */
const TABLAS_CLAVE = [
  'UserProfile',
  'Subject',
  'Topic',
  'Note',
  'NoteSection',
  'NoteBlock',
  'SourceDocument',
  'DocumentChunk',
  'StudyJob',
  'UserAiKey',
  'AiKeyAttempt',
  'PushSubscription',
  'PlanState',
  'TutorSessionOutcome',
];

const errores = [];
const avisos = [];
const notas = [];

function bloqueo(titulo, detalle) {
  errores.push({ titulo, detalle });
  console.log(`   ✗ ${titulo}`);
  if (detalle) console.log(`     ${detalle}`);
}

function aviso(titulo, detalle) {
  avisos.push({ titulo, detalle });
  console.log(`   ! ${titulo}`);
  if (detalle) console.log(`     ${detalle}`);
}

function nota(texto) {
  notas.push(texto);
  console.log(`   · ${texto}`);
}

function bien(texto) {
  console.log(`   ✓ ${texto}`);
}

function seccion(titulo) {
  console.log('');
  console.log(`── ${titulo} ${'─'.repeat(Math.max(0, 62 - titulo.length))}`);
}

function run(cmd, cmdArgs, options = {}) {
  const result = spawnSync(cmd, cmdArgs, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: options.timeout ?? 240_000,
    env: process.env,
  });
  return {
    code: typeof result.status === 'number' ? result.status : 1,
    texto: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
    error: result.error ?? null,
  };
}

function npmRun(script) {
  // En Windows npm es un .cmd: se lanza con cmd.exe en vez de `shell: true`,
  // que concatena argumentos sin escaparlos (DEP0190). `script` es una constante
  // de este archivo, no entrada del usuario.
  if (process.platform === 'win32') {
    return run('cmd.exe', ['/d', '/s', '/c', `npm run ${script}`], { timeout: 300_000 });
  }
  return run('npm', ['run', script], { timeout: 300_000 });
}

function tscPath() {
  return require.resolve('typescript/bin/tsc', { paths: [ROOT] });
}

function prismaCliPath() {
  const directo = path.join(ROOT, 'node_modules', 'prisma', 'build', 'index.js');
  if (fs.existsSync(directo)) return directo;
  const pkg = require.resolve('prisma/package.json', { paths: [ROOT] });
  const bin = require(pkg).bin;
  return path.join(path.dirname(pkg), typeof bin === 'string' ? bin : bin.prisma);
}

function prisma(cmdArgs, options = {}) {
  return run(process.execPath, [prismaCliPath(), ...cmdArgs], options);
}

/** Muestra una cadena de conexión sin credenciales. */
function describirUrl(raw) {
  if (!raw) return 'no definida';
  try {
    const url = new URL(raw);
    const base = url.pathname.replace(/^\//, '') || '(sin nombre)';
    return `${url.hostname}:${url.port || '5432'}/${base} · rol ${decodeURIComponent(url.username) || '?'}`;
  } catch {
    return 'cadena no válida (¿caracteres sin escapar en la contraseña?)';
  }
}

/** Sentencias que pierden datos o bloquean una tabla viva. `DROP INDEX` no cuenta. */
const PATRONES_PELIGROSOS = [
  { re: /\bDROP\s+TABLE\b/i, motivo: 'DROP TABLE' },
  { re: /\bDROP\s+COLUMN\b/i, motivo: 'DROP COLUMN' },
  { re: /\bDROP\s+TYPE\b/i, motivo: 'DROP TYPE' },
  { re: /\bTRUNCATE\b/i, motivo: 'TRUNCATE' },
  { re: /\bDELETE\s+FROM\b/i, motivo: 'DELETE FROM' },
  { re: /\bALTER\s+COLUMN\s+[^;]+\bTYPE\b/i, motivo: 'ALTER COLUMN … TYPE (reescribe la tabla)' },
  { re: /\bALTER\s+COLUMN\s+[^;]+\bSET\s+NOT\s+NULL\b/i, motivo: 'SET NOT NULL (puede fallar con datos existentes)' },
  { re: /\bRENAME\s+TO\b/i, motivo: 'RENAME (rompe el código desplegado)' },
];

function migracionesLocales() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function leerMigracion(nombre) {
  const file = path.join(MIGRATIONS_DIR, nombre, 'migration.sql');
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8');
}

/** Quita comentarios de línea para no confundir documentación con sentencias. */
function soloSentencias(sql) {
  return sql.replace(/--.*$/gm, '');
}

/* ─────────────────────────── 1. Entorno ─────────────────────────── */

function revisarEntorno() {
  seccion('1. Entorno y migraciones del repositorio');

  const mayor = Number(process.versions.node.split('.')[0]);
  if (mayor >= 20) bien(`Node ${process.versions.node}`);
  else bloqueo(`Node ${process.versions.node} es demasiado antiguo`, 'Netlify fija Node 20: usa la misma versión en local.');

  const databaseUrl = (process.env.DATABASE_URL ?? '').trim();
  const directUrl = (process.env.DIRECT_URL ?? '').trim();
  const appUrl = (process.env.PRISMA_APP_DATABASE_URL ?? '').trim();

  if (databaseUrl) bien(`DATABASE_URL → ${describirUrl(databaseUrl)}`);
  else bloqueo('Falta DATABASE_URL', 'La app (y `migrate status`) no pueden conectarse sin ella.');

  if (directUrl) bien(`DIRECT_URL → ${describirUrl(directUrl)}`);
  else bloqueo('Falta DIRECT_URL', '`prisma migrate` la exige (conexión directa o de sesión, sin pgbouncer).');

  if (directUrl) {
    try {
      const url = new URL(directUrl);
      if (url.hostname.endsWith('pooler.supabase.com') && url.port === '6543') {
        bloqueo(
          'DIRECT_URL apunta al pooler en modo transacción (6543)',
          'El DDL y los locks de `migrate deploy` no son fiables ahí. Usa el puerto 5432 (sesión) o el host directo.'
        );
      } else {
        bien('DIRECT_URL no usa el pooler de transacciones');
      }
      const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
      if (!local && !url.searchParams.has('sslmode')) {
        aviso('DIRECT_URL no declara sslmode', 'Supabase rechaza conexiones sin TLS (P1011). Añade sslmode=verify-full.');
      }
    } catch {
      bloqueo('DIRECT_URL no se puede parsear', 'Si la contraseña tiene @, # o /, va escapada en la URL.');
    }
  }

  if (appUrl) {
    bien(`PRISMA_APP_DATABASE_URL → ${describirUrl(appUrl)}`);
    bien('Runtime con rol dedicado (DML sin DDL)');
  } else {
    const detalle =
      'La app conectará con el rol dueño de las tablas: las políticas RLS no le afectan. ' +
      'Es aceptable mientras no se active TENANT_RLS_STRICT, pero es una deuda de seguridad.';
    if (ESTRICTO) bloqueo('Falta PRISMA_APP_DATABASE_URL y se ha pedido --estricto', detalle);
    else aviso('Falta PRISMA_APP_DATABASE_URL (runtime con DATABASE_URL)', detalle);
  }

  const estrictoEnv = (process.env.TENANT_RLS_STRICT ?? '').trim() === '1';
  if (estrictoEnv && !appUrl) {
    bloqueo('TENANT_RLS_STRICT=1 sin PRISMA_APP_DATABASE_URL', 'La app se niega a arrancar en ese estado.');
  } else if (estrictoEnv) {
    nota('TENANT_RLS_STRICT=1: las políticas deben ser fail-closed (sin `coalesce`).');
  } else {
    nota('TENANT_RLS_STRICT no está activo: RLS es permisiva fuera de `db(userId).$transaction`.');
  }

  // Schema válido.
  const validacion = prisma(['validate'], { timeout: 90_000 });
  if (validacion.code === 0) bien('prisma validate: esquema válido');
  else bloqueo('prisma validate ha fallado', validacion.texto.split('\n').slice(-6).join('\n'));

  // Auditoría de migraciones: orden, carpetas y sentencias destructivas.
  const nombres = migracionesLocales();
  if (nombres.length === 0) {
    bloqueo('No hay migraciones en prisma/migrations', 'Sin historial, `migrate deploy` no puede reconstruir el esquema.');
    return { databaseUrl, directUrl, nombres };
  }

  const malFormadas = nombres.filter((name) => !/^\d{14}_[a-z0-9_]+$/.test(name) || !leerMigracion(name));
  if (malFormadas.length === 0) bien(`${nombres.length} migraciones, nombre y migration.sql correctos`);
  else bloqueo(`Migraciones mal formadas: ${malFormadas.join(', ')}`, 'El nombre debe ser AAAAMMDDhhmmss_slug y contener migration.sql.');

  const repetidas = nombres.filter((name, index) => index > 0 && name.slice(0, 14) === nombres[index - 1].slice(0, 14));
  if (repetidas.length > 0) bloqueo(`Dos migraciones con la misma marca de tiempo: ${repetidas.join(', ')}`);

  const peligrosas = [];
  for (const nombre of nombres) {
    const sql = leerMigracion(nombre);
    if (!sql) continue;
    const limpio = soloSentencias(sql);
    for (const patron of PATRONES_PELIGROSOS) {
      if (patron.re.test(limpio)) peligrosas.push(`${nombre}: ${patron.motivo}`);
    }
  }
  if (peligrosas.length === 0) {
    bien('Ninguna migración contiene DROP/TRUNCATE/DELETE/RENAME ni ALTER COLUMN TYPE');
  } else {
    for (const item of peligrosas) {
      aviso(
        `Sentencia potencialmente destructiva en ${item.split(':')[0]}`,
        `${item.split(': ')[1]}. Si esa migración ya está aplicada es historial; si está pendiente, no la apliques sin copia y revisión.`
      );
    }
  }

  // pgvector: el tipo `vector(768)` del schema no siempre está visible.
  const schema = fs.readFileSync(path.join(ROOT, 'prisma', 'schema.prisma'), 'utf8');
  if (/Unsupported\("vector\(\d+\)"\)/.test(schema)) {
    const notaVector = leerMigracion('20261122120000_study_sources_and_modular_notes');
    if (notaVector && /double precision\[\]/.test(notaVector)) {
      aviso(
        '`DocumentChunk.embedding` es `Unsupported("vector(768)")` en Prisma, pero la migración tiene una rama de respaldo `double precision[]`',
        'Si el servidor no tiene pgvector, la columna real no coincide con el schema y `migrate dev`/`migrate diff` propondrán cambiarla. `migrate status` no detecta este desajuste.'
      );
    }
  }

  return { databaseUrl, directUrl, nombres };
}

/* ─────────────────────── 2. Estado de la base ─────────────────────── */

function resumirSalida(texto, maxLineas = 24) {
  const lineas = texto.split('\n').filter((line) => line.trim().length > 0);
  const recorte = lineas.slice(0, maxLineas);
  for (const linea of recorte) console.log(`     ${linea}`);
  if (lineas.length > maxLineas) console.log(`     … (${lineas.length - maxLineas} líneas más)`);
}

function revisarMigracionesAplicadas(nombresLocales) {
  seccion('2. Base de datos: migraciones pendientes');

  const estado = prisma(['migrate', 'status'], { timeout: 120_000 });
  const texto = estado.texto;

  if (estado.error) {
    bloqueo('No se ha podido ejecutar `prisma migrate status`', estado.error.message);
    return { disponible: false };
  }

  const inalcanzable = /P1001|P1000|P1017|can't reach database server|authentication failed/i.test(texto);
  if (inalcanzable) {
    bloqueo(
      'La base de datos no es alcanzable desde este entorno',
      'Revisa host/puerto, que el proyecto de Supabase no esté pausado y la IP permitida. ' +
        'Sin conexión no se puede comprobar RLS ni aplicar migraciones.'
    );
    resumirSalida(texto, 8);
    return { disponible: false };
  }

  if (estado.code !== 0) {
    const pendientes = /not yet been applied|have not yet been applied/i.test(texto);
    const fallidas = /failed/i.test(texto);
    if (fallidas) {
      bloqueo('Hay una migración fallida: el historial está bloqueado', 'Resuélvela a mano en `_prisma_migrations` antes de desplegar.');
    } else if (pendientes) {
      nota('Hay migraciones pendientes de aplicar (las resolverá `--aplicar` después de las comprobaciones).');
    } else {
      bloqueo('`prisma migrate status` ha fallado', 'Revisa la salida de abajo.');
    }
    resumirSalida(texto);
    return { disponible: true, pendientes, fallidas };
  }

  bien('El historial de migraciones está aplicado: nada pendiente');
  resumirSalida(texto, 6);
  return { disponible: true, pendientes: false, fallidas: false, nombresLocales };
}

/* ─────────────────────────── 3. RLS y roles ─────────────────────────── */

async function revisarRls(estadoMigraciones) {
  seccion('3. RLS, políticas y rol de runtime');

  let PrismaClient;
  try {
    ({ PrismaClient } = require('@prisma/client'));
  } catch (error) {
    bloqueo('No se ha podido cargar @prisma/client', `${error.message}. Ejecuta ` + '`npx prisma generate`.');
    return null;
  }

  const directUrl = (process.env.DIRECT_URL || process.env.DATABASE_URL || '').trim();
  if (!directUrl) {
    bloqueo('Sin DIRECT_URL/DATABASE_URL no se puede comprobar RLS');
    return null;
  }

  // `connect_timeout` evita que un host muerto deje la auditoría colgada.
  let url = directUrl;
  try {
    const parsed = new URL(directUrl);
    if (!parsed.searchParams.has('connect_timeout')) parsed.searchParams.set('connect_timeout', '8');
    url = parsed.toString();
  } catch {
    /* se usa tal cual */
  }

  const prismaDb = new PrismaClient({ datasources: { db: { url } } });
  const consulta = (sql) => prismaDb.$queryRawUnsafe(sql);

  try {
    const conexion = await conTimeout(prismaDb.$connect(), 15_000, 'conectar con la base');
    if (!conexion.ok) {
      bloqueo('La conexión con la base ha agotado el tiempo', conexion.error);
      return null;
    }
    bien('Conexión establecida');

    const [info] = await consulta(
      `SELECT current_user AS rol, current_database() AS base,
              current_setting('search_path') AS search_path,
              version() AS version`
    );
    nota(`Rol de auditoría: ${info.rol} · ${info.base} · search_path ${info.search_path}`);

    // Tablas clave.
    const listaTablas = TABLAS_CLAVE.map((t) => `('${t}')`).join(',');
    const tablas = await consulta(
      `SELECT t.nombre AS tabla,
              to_regclass('public.' || quote_ident(t.nombre)) IS NOT NULL AS existe
         FROM (VALUES ${listaTablas}) AS t(nombre)
        ORDER BY t.nombre`
    );
    const faltan = tablas.filter((row) => !row.existe).map((row) => row.tabla);
    if (faltan.length === 0) bien(`${TABLAS_CLAVE.length}/${TABLAS_CLAVE.length} tablas clave existen`);
    else {
      bloqueo(
        `Faltan ${faltan.length} tablas clave: ${faltan.join(', ')}`,
        'El código nuevo las consulta. Aplica `npm run despliegue:aplicar` ANTES de desplegar el build.'
      );
    }

    // Columnas de las migraciones de etapa educativa y categoría de materia.
    // Prisma selecciona por defecto TODAS las columnas escalares: si falta una,
    // cualquier `userProfile.findUnique` o `subject.findMany` responde P2021.
    const columnasEsperadas = [
      ['UserProfile', 'stage'],
      ['UserProfile', 'gradeLevel'],
      ['UserProfile', 'trackKey'],
      ['UserProfile', 'degreeName'],
      ['Subject', 'category'],
    ];
    const valoresColumnas = columnasEsperadas
      .map(([tabla, columna]) => `('${tabla}', '${columna}')`)
      .join(',');
    const columnas = await consulta(
      `SELECT v.tabla, v.columna, (c.column_name IS NOT NULL) AS existe
         FROM (VALUES ${valoresColumnas}) AS v(tabla, columna)
         LEFT JOIN information_schema.columns c
           ON c.table_schema = 'public'
          AND c.table_name = v.tabla
          AND c.column_name = v.columna
        ORDER BY v.tabla, v.columna`
    );
    const columnasQueFaltan = columnas.filter((row) => !row.existe);
    if (columnasQueFaltan.length === 0) {
      bien('Columnas de etapa educativa y categoría de materia presentes');
    } else {
      bloqueo(
        `Faltan columnas: ${columnasQueFaltan.map((r) => `${r.tabla}.${r.columna}`).join(', ')}`,
        'Las migraciones `education_stage` y `subject_category` siguen pendientes: Prisma lee todas las columnas escalares, así que hasta aplicarlas fallan las consultas de perfil y de materias.'
      );
    }

    // RLS activa en todas las tablas de public.
    const sinRls = await consulta(
      `SELECT c.relname AS tabla
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'p')
          AND c.relname <> '_prisma_migrations'
          AND NOT c.relrowsecurity
        ORDER BY 1`
    );
    if (sinRls.length === 0) bien('RLS activa en todas las tablas de `public`');
    else bloqueo(`RLS desactivada en ${sinRls.length} tabla(s): ${sinRls.map((r) => r.tabla).join(', ')}`);

    // Grants de anon / authenticated.
    const grants = await consulta(
      `SELECT grantee, table_name, privilege_type
         FROM information_schema.role_table_grants
        WHERE table_schema = 'public'
          AND grantee IN ('anon', 'authenticated')
        ORDER BY 1, 2`
    );
    if (grants.length === 0) bien('`anon` y `authenticated` no tienen ningún grant en `public`');
    else {
      bloqueo(
        `Hay ${grants.length} grant(s) a anon/authenticated`,
        `${grants.slice(0, 5).map((g) => `${g.grantee}:${g.table_name}`).join(', ')}… Supabase expone esas tablas por PostgREST.`
      );
    }

    // Rol de runtime.
    const [rol] = await consulta(
      `SELECT rolname, rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolconfig
         FROM pg_roles
        WHERE rolname = 'prisma_app'`
    );

    let hayRol = Boolean(rol);
    if (!rol) {
      const detalle =
        'La app conecta con el rol dueño: RLS no la protege. Crea el rol con ' +
        '`psql "$DIRECT_URL" -v app_password=… -f prisma/sql/prisma_app.sql`.';
      if (ESTRICTO) bloqueo('No existe el rol `prisma_app`', detalle);
      else aviso('No existe el rol de runtime `prisma_app`', detalle);
    } else {
      const problemas = [];
      if (!rol.rolcanlogin) problemas.push('NOLOGIN');
      if (rol.rolsuper) problemas.push('SUPERUSER');
      if (rol.rolbypassrls) problemas.push('BYPASSRLS');
      if (rol.rolcreatedb) problemas.push('CREATEDB');
      if (rol.rolcreaterole) problemas.push('CREATEROLE');
      if (problemas.length === 0) bien('`prisma_app` es LOGIN sin SUPERUSER, BYPASSRLS, CREATEDB ni CREATEROLE');
      else bloqueo(`El rol \`prisma_app\` tiene atributos peligrosos: ${problemas.join(', ')}`);

      let privilegios = null;
      try {
        [privilegios] = await consulta(
          `SELECT has_schema_privilege('prisma_app', 'public', 'CREATE') AS puede_ddl,
                  has_table_privilege('prisma_app', 'public."_prisma_migrations"', 'SELECT') AS ve_migraciones`
        );
      } catch {
        // `_prisma_migrations` puede no existir aún; no es un fallo del rol.
        nota('No se pudo comprobar el DDL de `prisma_app` (falta `_prisma_migrations`?).');
      }
      if (privilegios?.puede_ddl) bloqueo('`prisma_app` puede crear objetos en `public` (DDL)');
      else bien('`prisma_app` no puede hacer DDL en `public`');
      if (privilegios?.ve_migraciones) bloqueo('`prisma_app` puede leer `_prisma_migrations`');
      else bien('`prisma_app` no puede leer `_prisma_migrations`');

      const config = Array.isArray(rol.rolconfig) ? rol.rolconfig.join(' ') : '';
      if (/statement_timeout/.test(config)) bien(`Timeouts del rol: ${config.replace(/\s+/g, ' ')}`);
      else aviso('`prisma_app` no tiene `statement_timeout` configurado', 'Una consulta puede ocupar una conexión del pooler sin tope.');
    }

    // Políticas.
    const politicas = await consulta(
      `SELECT tablename, qual
         FROM pg_policies
        WHERE schemaname = 'public'
          AND policyname = 'brainup_app_runtime'
        ORDER BY tablename`
    );
    const permisivas = politicas.filter((p) => typeof p.qual === 'string' && p.qual.includes('coalesce('));

    if (hayRol) {
      const totalPublicas = await consulta(
        `SELECT count(*)::int AS total
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname <> '_prisma_migrations'`
      );
      const sinPolitica = Number(totalPublicas[0]?.total ?? 0) - politicas.length;
      if (sinPolitica <= 0) bien(`Política \`brainup_app_runtime\` en las ${politicas.length} tablas`);
      else if (estadoMigraciones?.pendientes) {
        nota(`Faltan políticas en ${sinPolitica} tabla(s): es lo esperado con migraciones pendientes.`);
      } else {
        bloqueo(`Faltan políticas en ${sinPolitica} tabla(s)`, 'Ejecuta `SELECT public.brainup_apply_app_rls();` tras migrar.');
      }

      if (permisivas.length === 0) bien('Las políticas son fail-closed (sin `app.user_id` no hay filas)');
      else if (ESTRICTO || (process.env.TENANT_RLS_STRICT ?? '').trim() === '1') {
        bloqueo(
          `Hay ${permisivas.length} política(s) permisivas con TENANT_RLS_STRICT`,
          'Con modo estricto, aplica `psql "$DIRECT_URL" -f prisma/sql/rls_strict_tenant.sql`.'
        );
      } else {
        aviso(
          `${permisivas.length} política(s) son permisivas sin \`app.user_id\` (diseño actual)`,
          'RLS solo aísla dentro de `db(userId).$transaction`. Para cerrarla del todo: ' +
            '`psql "$DIRECT_URL" -f prisma/sql/rls_strict_tenant.sql` tras desplegar el código con TENANT_RLS_STRICT=1.'
        );
      }
    }

    // pgvector y el desajuste conocido de `DocumentChunk.embedding`.
    const [vectorDisponible] = await consulta(
      `SELECT default_version, installed_version FROM pg_available_extensions WHERE name = 'vector'`
    );
    const [vectorInstalado] = await consulta(
      `SELECT n.nspname AS esquema
         FROM pg_extension e
         JOIN pg_namespace n ON n.oid = e.extnamespace
        WHERE e.extname = 'vector'`
    );
    const [tipoVisible] = await consulta(`SELECT to_regtype('vector') IS NOT NULL AS visible`);

    if (!vectorDisponible) {
      aviso(
        'pgvector no está disponible en el servidor',
        'La migración del lienzo creará `DocumentChunk.embedding` como `double precision[]`. La app funciona, pero el schema declara `vector(768)` y Prisma verá deriva.'
      );
    } else if (!vectorInstalado) {
      aviso(
        'pgvector está disponible pero no instalado',
        `La migración intentará \`CREATE EXTENSION vector\` con el rol de migraciones; si ese rol no puede, la migración falla y se revierte. ` +
          'Recomendado: habilitar `vector` en el panel de Supabase antes de migrar.'
      );
    } else if (!tipoVisible?.visible) {
      bloqueo(
        `pgvector está instalado en el esquema \`${vectorInstalado.esquema}\` pero el tipo \`vector\` no está en el search_path`,
        `\`CREATE EXTENSION IF NOT EXISTS\` no hará nada y \`vector(768)\` no resolverá: la migración fallará. ` +
          `Antes de migrar, asegura que \`search_path\` incluye \`${vectorInstalado.esquema}\` ` +
          `(o mueve la extensión a \`public\`). En Supabase se habilita desde el panel de extensiones.`
      );
    } else {
      bien(`pgvector ${vectorDisponible.installed_version} visible (esquema ${vectorInstalado.esquema})`);
    }

    const [columna] = await consulta(
      `SELECT format_type(a.atttypid, a.atttypmod) AS tipo
         FROM pg_attribute a
        WHERE a.attrelid = to_regclass('public."DocumentChunk"')
          AND a.attname = 'embedding'
          AND NOT a.attisdropped`
    );
    if (columna) {
      if (String(columna.tipo).startsWith('vector')) bien(`DocumentChunk.embedding es ${columna.tipo}`);
      else aviso(`DocumentChunk.embedding es ${columna.tipo}`, 'Es la rama de respaldo documentada; el schema dice `vector(768)`.');
    }

    // Migraciones aplicadas que no están en el repositorio. En una base recién
    // creada la tabla aún no existe: eso no es un fallo de seguridad.
    let aplicadas = [];
    try {
      aplicadas = await consulta(
        `SELECT migration_name, finished_at, rolled_back_at
           FROM "_prisma_migrations"
          ORDER BY started_at`
      );
    } catch {
      nota('La base no tiene `_prisma_migrations` (esquema sin migrar).');
    }
    const locales = new Set(migracionesLocales());
    const huerfanas = aplicadas.filter((row) => !locales.has(row.migration_name));
    if (huerfanas.length === 0) bien('Historial de la base coherente con prisma/migrations');
    else aviso(`${huerfanas.length} migración(es) aplicadas que no están en el repo`, huerfanas.map((r) => r.migration_name).join(', '));

    const pendientesLocales = migracionesLocales().filter(
      (name) => !aplicadas.some((row) => row.migration_name === name)
    );
    if (pendientesLocales.length > 0) {
      nota(`Pendientes en la base: ${pendientesLocales.join(', ')}`);
    }

    return { permisivas: permisivas.length, hayRol, vectorInstalado: Boolean(vectorInstalado) };
  } catch (error) {
    bloqueo('La auditoría de RLS ha fallado', error instanceof Error ? error.message : String(error));
    return null;
  } finally {
    // No se espera indefinidamente: si `$connect` sigue colgado, cerrar el
    // cliente no puede dejar la auditoría sin terminar.
    await Promise.race([
      prismaDb.$disconnect().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ]);
  }
}

/** Carrera contra el reloj: un host muerto no puede colgar la auditoría. */
function conTimeout(promise, ms, etiqueta) {
  return Promise.race([
    promise.then(() => ({ ok: true })),
    new Promise((resolve) =>
      setTimeout(() => resolve({ ok: false, error: `Tiempo agotado al ${etiqueta} (${ms} ms)` }), ms)
    ),
  ]);
}

/* ───────────────────────── 4. Verificación ───────────────────────── */

function revisarVerificaciones() {
  seccion('4. Verificación del código');

  const tsc = run(process.execPath, [tscPath(), '--noEmit'], { timeout: 240_000 });
  if (tsc.code === 0) bien('tsc --noEmit');
  else {
    bloqueo('tsc --noEmit ha fallado', 'Sin tipos limpios no se despliega.');
    resumirSalida(tsc.texto, 15);
  }

  const scripts = ['verify:lienzo', 'verify:security', 'verify:stages', 'verify:materias'];
  for (const script of scripts) {
    const resultado = npmRun(script);
    if (resultado.code === 0) bien(`npm run ${script}`);
    else {
      bloqueo(`npm run ${script} ha fallado`);
      resumirSalida(resultado.texto, 18);
    }
  }

  if (CON_BUILD) {
    const lint = npmRun('lint');
    if (lint.code === 0) bien('npm run lint');
    else {
      bloqueo('npm run lint ha fallado');
      resumirSalida(lint.texto, 15);
    }

    const build = npmRun('build');
    if (build.code === 0) bien('npm run build');
    else {
      bloqueo('npm run build ha fallado', 'Comprueba que no haya un `next start` reteniendo el DLL de Prisma.');
      resumirSalida(build.texto, 20);
    }
  } else {
    console.log('   · `--build` añade lint y build (más lento; úsalo antes de publicar en Netlify).');
  }
}

/* ────────────────────────── 5. Despliegue ────────────────────────── */

function backupsRecientes(horas = 24) {
  if (!fs.existsSync(BACKUPS_DIR)) return [];
  return fs
    .readdirSync(BACKUPS_DIR)
    .filter((name) => /\.(dump|sql|gz|bak)$/i.test(name))
    .map((name) => {
      const file = path.join(BACKUPS_DIR, name);
      const stat = fs.statSync(file);
      return { name, mtime: stat.mtimeMs, size: stat.size };
    })
    .filter((item) => Date.now() - item.mtime < horas * 3600_000)
    .sort((a, b) => b.mtime - a.mtime);
}

async function aplicarMigraciones(rlsAntes) {
  seccion('5. Aplicar migraciones');

  const recientes = backupsRecientes(24);
  if (recientes.length === 0) {
    if (!SIN_BACKUP) {
      bloqueo(
        'No hay ninguna copia de seguridad de las últimas 24 h en data/backups/',
        'Haz `npm run db:backup` (o un dump con pg_dump) y vuelve a ejecutar. Si ya tienes la copia fuera, usa `--sin-backup`.'
      );
      return false;
    }
    aviso('Se migra sin copia reciente en data/backups/ (--sin-backup)');
  } else {
    const ultima = recientes[0];
    bien(`Copia reciente: ${ultima.name} (${Math.round(ultima.size / 1024)} KB)`);
  }

  nota('Ejecutando `prisma migrate deploy` con DIRECT_URL…');
  const deploy = prisma(['migrate', 'deploy'], { timeout: 300_000 });
  if (deploy.code !== 0) {
    bloqueo('`prisma migrate deploy` ha fallado', 'La migración de PostgreSQL es transaccional: revisa el error y no reintentes a ciegas.');
    resumirSalida(deploy.texto, 25);
    return false;
  }
  resumirSalida(deploy.texto, 20);

  const estado = prisma(['migrate', 'status'], { timeout: 120_000 });
  if (estado.code === 0) bien('`migrate status` limpio tras aplicar');
  else {
    bloqueo('`migrate status` sigue sin estar limpio tras el despliegue', 'No despliegues el build hasta resolverlo.');
    resumirSalida(estado.texto, 15);
  }

  // La función permisiva de la migración puede haber pisado las políticas
  // estrictas: se comprueba y, si ha pasado, se dice con el comando exacto.
  if (rlsAntes && rlsAntes.permisivas === 0 && rlsAntes.hayRol) {
    const despues = await revisarRls({ pendientes: false });
    const permisivasDespues = despues?.permisivas ?? 0;
    if (permisivasDespues > 0) {
      bloqueo(
        'La migración ha vuelto a dejar políticas RLS permisivas',
        '`brainup_apply_app_rls()` sustituye las políticas fail-closed. Ejecuta ahora: ' +
          'psql "$DIRECT_URL" -f prisma/sql/rls_strict_tenant.sql'
      );
    }
  }

  return true;
}

/* ─────────────────────────── Resumen ─────────────────────────── */

function resumen(final) {
  seccion('Resumen');
  console.log(`   Migraciones en el repositorio: ${migracionesLocales().length}`);
  console.log(`   Bloqueos: ${errores.length} · Avisos: ${avisos.length}`);
  if (errores.length > 0) {
    console.log('\n   NO DESPLEGAR todavía:');
    for (const item of errores) console.log(`   ✗ ${item.titulo}`);
  } else if (final) {
    console.log('\n   ✓ LISTO PARA DESPLEGAR el build de la app.');
  } else {
    console.log('\n   ✓ Auditoría en verde (no se ha escrito nada).');
  }

  if (notas.length > 0) {
    console.log('\n   Recordatorios:');
    for (const texto of notas) console.log(`   · ${texto}`);
  }

  console.log('\n   Orden obligatorio en Netlify:');
  console.log('     1) npm run despliegue:aplicar   (esquema primero)');
  console.log('     2) desplegar el build           (el código lee las tablas nuevas)');
  console.log('     3) comprobar /api/salud y abrir /apuntes con una cuenta real');
}

function ayuda() {
  console.log(`
Despliegue maestro de BrainUp Academy.

  npm run despliegue:check                 auditoría read-only (entorno, base, RLS, tests)
  npm run despliegue:check -- --solo-codigo  sin conexión a la base (CI)
  npm run despliegue:aplicar               audita y aplica migraciones si todo está en verde
  npm run despliegue:completo              + lint y build

Banderas: --solo-codigo, --aplicar, --build, --sin-backup, --estricto, --ayuda

Salida: 0 sin bloqueos (puede haber avisos), 1 no desplegar.
`);
}

/* ─────────────────────────── Main ─────────────────────────── */

async function main() {
  if (AYUDA) {
    ayuda();
    return;
  }

  console.log('BrainUp Academy · despliegue maestro');
  console.log(`   Modo: ${APLICAR ? 'auditar y aplicar migraciones' : 'auditar (read-only)'}${CON_BUILD ? ' + build' : ''}`);

  const { nombres } = revisarEntorno();

  let estadoMigraciones = { disponible: false };
  let rlsAntes = null;

  if (SOLO_CODIGO) {
    seccion('2. Base de datos');
    console.log('   · Omitida por --solo-codigo: no se abre ninguna conexión.');
    seccion('3. RLS y roles');
    console.log('   · Omitida por --solo-codigo.');
  } else {
    estadoMigraciones = revisarMigracionesAplicadas(nombres);
    if (estadoMigraciones.disponible) {
      rlsAntes = await revisarRls(estadoMigraciones);
    } else {
      seccion('3. RLS, políticas y rol de runtime');
      console.log('   · Omitida: sin conexión no se puede leer `pg_class` ni `pg_policies`.');
    }
  }

  revisarVerificaciones();

  const previos = errores.length;

  if (APLICAR) {
    if (SOLO_CODIGO) {
      bloqueo('`--aplicar` exige conexión con la base', 'Quita `--solo-codigo`.');
    } else if (!estadoMigraciones.disponible) {
      bloqueo('No se puede aplicar: la base no responde', 'Arregla la conexión y repite.');
    } else if (previos > 0) {
      bloqueo('No se aplican migraciones con bloqueos abiertos', 'Resuelve los ✗ de arriba; los avisos no impiden migrar.');
    } else {
      await aplicarMigraciones(rlsAntes);
    }
  }

  resumen(APLICAR);
  process.exitCode = errores.length > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error('\nEl despliegue maestro ha fallado inesperadamente:');
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
