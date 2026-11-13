/**
 * Migración 1e: mueve TODOS los datos de `user_default` al UUID de Supabase Auth.
 *
 * Uso:
 *   BRAINUP_USER_ID=<uuid> node scripts/migrate-user-id.js
 *   BRAINUP_USER_ID=<uuid> node scripts/migrate-user-id.js --apply
 *
 * Sin `--apply` solo hace el preflight: valida el UUID, las FKs y cuenta filas.
 * Con `--apply` ejecuta UNA transacción contra DIRECT_URL. Si cualquier recuento
 * no cuadra, lanza y PostgreSQL hace ROLLBACK.
 *
 * Este script es histórico: es el único sitio, fuera de las migraciones, donde
 * aparece `user_default` a propósito.
 */
const { PrismaClient } = require('@prisma/client');
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const OLD_ID = 'user_default';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(message) {
  console.error(`\n  ⛔ ${message}\n`);
  process.exit(1);
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

async function tableNames(prisma) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT table_name
       FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'userId'
      ORDER BY table_name`
  );
  return rows.map((row) => row.table_name);
}

async function counts(prisma, tables) {
  const result = {};
  for (const table of tables) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM public.${quoteIdent(table)}`
    );
    result[table] = rows[0].n;
  }
  return result;
}

async function countsByUser(prisma, tables, userId) {
  const result = {};
  for (const table of tables) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM public.${quoteIdent(table)} WHERE "userId" = $1`,
      userId
    );
    result[table] = rows[0].n;
  }
  return result;
}

async function main() {
  const targetId = String(process.env.BRAINUP_USER_ID ?? '').trim();
  const apply = process.argv.includes('--apply');
  const directUrl = String(process.env.DIRECT_URL ?? '').trim();

  if (!targetId) fail('Falta BRAINUP_USER_ID con el UUID de auth.users.');
  if (!UUID_RE.test(targetId)) fail('BRAINUP_USER_ID no es un UUID válido.');
  if (!directUrl) fail('Falta DIRECT_URL (conexión directa, sin pooler).');

  const prisma = new PrismaClient({ datasources: { db: { url: directUrl } } });

  try {
    const profile = await prisma.$queryRawUnsafe(
      `SELECT id, count(*) OVER ()::int AS total
         FROM "UserProfile"
        WHERE id IN ($1, $2)`,
      OLD_ID,
      targetId
    );

    const oldProfile = profile.find((row) => row.id === OLD_ID);
    const targetProfile = profile.find((row) => row.id === targetId);
    if (!oldProfile) fail(`No existe UserProfile con id ${OLD_ID}: no hay nada que migrar.`);
    if (targetProfile) fail(`Ya existe UserProfile con id ${targetId}: no se sobrescribe.`);

    const fkRows = await prisma.$queryRawUnsafe(
      `SELECT conrelid::regclass::text AS table_name, confupdtype
         FROM pg_constraint
        WHERE contype = 'f' AND confrelid = '"UserProfile"'::regclass
        ORDER BY 1`
    );
    const withoutCascade = fkRows.filter((row) => row.confupdtype !== 'c');
    if (withoutCascade.length > 0) {
      fail(
        `Hay FKs sin ON UPDATE CASCADE: ${withoutCascade
          .map((row) => `${row.table_name}(${row.confupdtype})`)
          .join(', ')}`
      );
    }

    const tables = await tableNames(prisma);
    const before = await counts(prisma, tables);
    const oldByUser = await countsByUser(prisma, tables, OLD_ID);
    const targetByUser = await countsByUser(prisma, tables, targetId);

    const moved = Object.values(oldByUser).reduce((sum, n) => sum + n, 0);
    const alreadyThere = Object.values(targetByUser).reduce((sum, n) => sum + n, 0);

    console.log(`\n  Preflight`);
    console.log(`  · Tablas con userId: ${tables.length}`);
    console.log(`  · Filas de ${OLD_ID}: ${moved}`);
    console.log(`  · Filas ya en el UUID destino: ${alreadyThere}`);
    console.log(`  · FKs a UserProfile con ON UPDATE CASCADE: ${fkRows.length}`);
    console.log(`  · Modo: ${apply ? 'APLICAR (transacción)' : 'solo preflight'}\n`);

    if (!apply) {
      console.log('  No se ha escrito nada. Repite con --apply para migrar.\n');
      return;
    }

    const outcome = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE "UserProfile" SET id = $1 WHERE id = $2`,
          targetId,
          OLD_ID
        );

        const after = await counts(tx, tables);
        const afterByUser = await countsByUser(tx, tables, targetId);
        const leftovers = await countsByUser(tx, tables, OLD_ID);
        const profileRows = await tx.$queryRawUnsafe(
          `SELECT count(*)::int AS n FROM "UserProfile" WHERE id = $1`,
          targetId
        );

        for (const table of tables) {
          if (after[table] !== before[table]) {
            throw new Error(
              `Recuento distinto en ${table}: antes ${before[table]}, después ${after[table]}.`
            );
          }
          if (afterByUser[table] !== before[table]) {
            throw new Error(
              `${table}: ${afterByUser[table]} filas en el UUID destino, se esperaban ${before[table]}.`
            );
          }
          if (leftovers[table] !== 0) {
            throw new Error(`${table}: quedan ${leftovers[table]} filas en ${OLD_ID}.`);
          }
        }

        if (profileRows[0].n !== 1) {
          throw new Error(`UserProfile destino: ${profileRows[0].n} filas, se esperaba 1.`);
        }

        return { after, afterByUser, profileRows: profileRows[0].n };
      },
      { timeout: 120_000 }
    );

    const evidence = {
      migratedAt: new Date().toISOString(),
      from: OLD_ID,
      to: targetId,
      tables: tables.length,
      before,
      after: outcome.after,
      afterByUser: outcome.afterByUser,
      profileRows: outcome.profileRows,
    };

    const dir = path.join(process.cwd(), 'data', 'backups');
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = path.join(dir, `user-id-migration-${stamp}.json`);
    writeFileSync(file, JSON.stringify(evidence, null, 2), 'utf8');

    console.log('  ✅ Migración aplicada y verificada.');
    console.log(`  · Evidencia: ${file}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('\n  ❌ ROLLBACK: la transacción no se ha confirmado.');
  console.error(`  ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
