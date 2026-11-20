/**
 * Rellena `stage`, `gradeLevel`, `trackKey` y `degreeName` desde `modality`.
 *
 * Es el backfill del Paso 11 (Commit 1): los perfiles que ya existían antes del
 * enum EducationStage siguen guardando el curso en `modality`. Este script lo
 * traduce una sola vez, sin tocar `modality` ni borrar materias.
 *
 * Idempotente: solo escribe las filas cuyo valor derivado difiere del guardado,
 * así que ejecutarlo dos veces no cambia nada la segunda vez.
 *
 * Uso:
 *   node scripts/backfill-education-stage.js            # simulación (por defecto)
 *   node scripts/backfill-education-stage.js --apply    # escribe en la base
 *   node scripts/backfill-education-stage.js --limit=5  # solo una muestra
 *
 * IMPORTANTE: usa la `DATABASE_URL` del entorno. En este proyecto esa cadena
 * apunta a producción, así que `--apply` es una escritura real: se ejecuta a
 * mano, después de una copia de seguridad y con autorización explícita.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const projectRoot = path.join(__dirname, '..');
const outDir = path.join(projectRoot, '.tmp-backfill-stage');

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

/** Compila el catálogo de etapas a un directorio temporal para poder requerirlo. */
function loadStagesModule() {
  fs.rmSync(outDir, { recursive: true, force: true });
  execFileSync(
    process.execPath,
    [
      require.resolve('typescript/bin/tsc'),
      path.join('src', 'lib', 'stages', 'types.ts'),
      path.join('src', 'lib', 'stages', 'catalog.ts'),
      '--outDir',
      '.tmp-backfill-stage',
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
  return require(path.join(outDir, 'catalog.js'));
}

function main() {
  loadEnv();
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const limitArg = args.find((arg) => arg.startsWith('--limit='));
  const limit = limitArg ? Math.max(1, Number(limitArg.split('=')[1]) || 0) : 0;

  if (!process.env.DATABASE_URL) {
    console.error('Falta DATABASE_URL. No se toca nada.');
    process.exit(1);
  }

  const stages = loadStagesModule();
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();

  return (async () => {
    const profiles = await prisma.userProfile.findMany({
      select: {
        id: true,
        modality: true,
        stage: true,
        gradeLevel: true,
        trackKey: true,
        degreeName: true,
      },
      orderBy: { createdAt: 'asc' },
      ...(limit > 0 ? { take: limit } : {}),
    });

    const pending = [];
    const byStage = { ESO: 0, BACHILLERATO: 0, UNIVERSIDAD: 0 };
    let unknown = 0;

    for (const profile of profiles) {
      const selection = stages.inferStageFromModality(profile.modality);
      if (!stages.isRecognizedModality(profile.modality)) unknown += 1;

      // En una modalidad desconocida solo se fija la etapa por defecto: no se
      // inventan curso ni rama que el texto no diga.
      const target = stages.isRecognizedModality(profile.modality)
        ? {
            stage: selection.stage,
            gradeLevel: selection.gradeLevel,
            trackKey: selection.trackKey,
            degreeName: selection.degreeName,
          }
        : {
            stage: 'BACHILLERATO',
            gradeLevel: null,
            trackKey: null,
            degreeName: null,
          };

      const changed =
        profile.stage !== target.stage ||
        profile.gradeLevel !== target.gradeLevel ||
        profile.trackKey !== target.trackKey ||
        profile.degreeName !== target.degreeName;

      if (changed) {
        byStage[target.stage] += 1;
        pending.push({ id: profile.id, modality: profile.modality, target });
      }
    }

    console.log(`Perfiles leídos: ${profiles.length}`);
    console.log(
      `Pendientes de actualizar: ${pending.length} (ESO ${byStage.ESO}, Bachillerato ${byStage.BACHILLERATO}, Universidad ${byStage.UNIVERSIDAD})`
    );
    if (unknown > 0) {
      console.log(`Modalidades no reconocidas (se dejan con etapa Bachillerato y curso nulo): ${unknown}`);
    }

    for (const row of pending.slice(0, 10)) {
      console.log(
        `  · ${row.id.slice(0, 8)}… «${row.modality}» → ${row.target.stage}/${row.target.gradeLevel ?? '—'}${row.target.trackKey ? ` (${row.target.trackKey})` : ''}`
      );
    }
    if (pending.length > 10) console.log(`  … y ${pending.length - 10} más`);

    if (!apply) {
      console.log('\nSIMULACIÓN: no se ha escrito nada. Repite con --apply para aplicar.');
      return;
    }

    let updated = 0;
    for (const row of pending) {
      await prisma.userProfile.update({
        where: { id: row.id },
        data: row.target,
      });
      updated += 1;
    }
    console.log(`\nAplicado: ${updated} perfiles actualizados.`);
  })()
    .catch((error) => {
      console.error('Backfill fallido:', error instanceof Error ? error.message : error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
      fs.rmSync(outDir, { recursive: true, force: true });
    });
}

main();
