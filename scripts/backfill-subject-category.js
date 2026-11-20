/**
 * Rellena `Subject.category` desde el nombre de la materia.
 *
 * Es el backfill opcional del Paso 14: la app ya funciona con `category = null`
 * porque `subjectCategoryOf` infiere la categoría en tiempo de lectura. Este
 * script solo deja el dato escrito para poder consultarlo en SQL.
 *
 * Idempotente: solo escribe las materias con `category` NULL. Nunca pisa una
 * categoría elegida por el alumno.
 *
 * Uso:
 *   node scripts/backfill-subject-category.js            # simulación (por defecto)
 *   node scripts/backfill-subject-category.js --apply    # escribe en la base
 *   node scripts/backfill-subject-category.js --limit=10 # solo una muestra
 *
 * IMPORTANTE: usa la `DATABASE_URL` del entorno. En este proyecto esa cadena
 * apunta a producción, así que `--apply` es una escritura real: se ejecuta a
 * mano, con copia de seguridad y autorización explícita.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const projectRoot = path.join(__dirname, '..');
const outDir = path.join(projectRoot, '.tmp-backfill-materias');

function loadEnv() {
  const file = path.join(projectRoot, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function loadCategoryModule() {
  fs.rmSync(outDir, { recursive: true, force: true });
  execFileSync(
    process.execPath,
    [
      require.resolve('typescript/bin/tsc'),
      path.join('src', 'lib', 'subjects', 'category.ts'),
      '--outDir',
      '.tmp-backfill-materias',
      '--module',
      'commonjs',
      '--target',
      'es2022',
      '--moduleResolution',
      'node',
      '--skipLibCheck',
      '--esModuleInterop',
    ],
    { cwd: projectRoot, stdio: 'inherit' }
  );
  return require(path.join(outDir, 'category.js'));
}

async function main() {
  loadEnv();
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const limitArg = args.find((arg) => arg.startsWith('--limit='));
  const limit = limitArg ? Math.max(1, Number(limitArg.split('=')[1]) || 0) : 0;

  if (!process.env.DATABASE_URL) {
    console.error('Falta DATABASE_URL. No se toca nada.');
    process.exit(1);
  }

  const categories = loadCategoryModule();
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();

  try {
    const subjects = await prisma.subject.findMany({
      select: { id: true, name: true, category: true },
      orderBy: [{ userId: 'asc' }, { order: 'asc' }],
      ...(limit > 0 ? { take: limit } : {}),
    });

    const pending = subjects
      .filter((subject) => subject.category === null)
      .map((subject) => ({
        id: subject.id,
        name: subject.name,
        category: categories.inferSubjectCategory(subject.name),
      }));

    const distribution = {};
    for (const row of pending) {
      distribution[row.category] = (distribution[row.category] ?? 0) + 1;
    }

    console.log(
      `Materias: ${subjects.length} · sin categoría: ${pending.length} · ya decididas: ${
        subjects.length - pending.length
      }`
    );
    if (pending.length > 0) {
      console.log('Reparto propuesto:', distribution);
      for (const row of pending.slice(0, 20)) {
        console.log(`  · ${row.name} → ${row.category}`);
      }
      if (pending.length > 20) console.log(`  … y ${pending.length - 20} más.`);
    }

    if (!apply) {
      console.log('\nSimulación. Nada escrito. Para escribir: --apply');
      return;
    }

    let written = 0;
    for (const row of pending) {
      await prisma.subject.update({
        where: { id: row.id },
        data: { category: row.category },
      });
      written += 1;
    }
    console.log(`\nEscritas ${written} materia(s).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('Backfill interrumpido:', error instanceof Error ? error.message : error);
  process.exit(1);
});
