/**
 * Verificación del orquestador `ensureTodayPlan` contra una base LOCAL.
 *
 * Nunca se ejecuta contra producción: si el host de `DATABASE_URL` no es
 * localhost, el script se niega. Comprueba:
 *
 *   1. Dos aperturas concurrentes dejan UN solo `PlanState`.
 *   2. Repetir la apertura no duplica bloques.
 *   3. Un bloque `en_curso` y otro completado sobreviven sin cambios.
 *
 * Uso:
 *   DATABASE_URL=postgresql://...@127.0.0.1:55432/brainup_test \
 *   DIRECT_URL=... BRAINUP_USER_ID=<uuid> node scripts/verify-planificador-dia.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const url = String(process.env.DATABASE_URL ?? '');
const host = (() => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
})();
if (!['127.0.0.1', 'localhost'].includes(host)) {
  console.error(`\n  ⛔ Solo contra una copia local. Host recibido: ${host || '(vacío)'}\n`);
  process.exit(1);
}

process.env.DIRECT_URL = process.env.DIRECT_URL || url;

// Cargador mínimo de TypeScript para este proceso de verificación.
require.extensions['.ts'] = (module_, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  module_._compile(js, filename);
};

const { PrismaClient } = require('@prisma/client');
const { ensureTodayPlan } = require(path.join(__dirname, '..', 'src', 'lib', 'dayPlan.ts'));

const USER_ID = String(process.env.BRAINUP_USER_ID ?? '').trim();
if (!USER_ID) {
  console.error('\n  ⛔ Falta BRAINUP_USER_ID.\n');
  process.exit(1);
}

const prisma = new PrismaClient();
const now = new Date();
const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
const dayEnd = new Date(dayStart.getTime() + 86_400_000);
let fixtureIds = [];

async function main() {
  const topic = await prisma.topic.findFirst({
    where: { userId: USER_ID },
    select: { id: true },
  });
  assert.ok(topic, 'la copia local necesita al menos un tema');

  // Día limpio: solo en la copia local. Así la generación ocurre de verdad.
  await prisma.planState.deleteMany({
    where: { userId: USER_ID, day: { gte: dayStart, lt: dayEnd } },
  });
  await prisma.studyBlock.deleteMany({
    where: {
      userId: USER_ID,
      date: { gte: dayStart, lt: dayEnd },
      isCompleted: false,
      status: 'pendiente',
      origin: { in: ['plan', 'reprogramada', 'recuperacion'] },
    },
  });

  await Promise.all([ensureTodayPlan(USER_ID, now), ensureTodayPlan(USER_ID, now)]);

  const plans = await prisma.planState.count({
    where: { userId: USER_ID, day: { gte: dayStart, lt: dayEnd } },
  });
  assert.equal(plans, 1, `PlanState debería ser 1, es ${plans}`);

  const before = await prisma.studyBlock.count({
    where: { userId: USER_ID, date: { gte: dayStart, lt: dayEnd } },
  });
  await ensureTodayPlan(USER_ID, now);
  const after = await prisma.studyBlock.count({
    where: { userId: USER_ID, date: { gte: dayStart, lt: dayEnd } },
  });
  assert.equal(after, before, `la segunda apertura duplicó bloques: ${before} -> ${after}`);

  const duplicated = await prisma.$queryRawUnsafe(
    `SELECT "topicId", technique, count(*)::int AS n
       FROM "StudyBlock"
      WHERE "userId" = $1 AND date >= $2 AND date < $3
        AND id <> ALL($4::text[])
      GROUP BY "topicId", technique
     HAVING count(*) > 1`,
    USER_ID,
    dayStart,
    dayEnd,
    fixtureIds
  );
  assert.equal(duplicated.length, 0, `bloques duplicados: ${JSON.stringify(duplicated)}`);

  // Ahora sí: lo empezado y lo completado no pueden cambiar.
  const running = await prisma.studyBlock.create({
    data: {
      userId: USER_ID,
      topicId: topic.id,
      date: dayStart,
      durationMinutes: 25,
      technique: 'active_recall',
      status: 'en_curso',
      isCompleted: false,
      objective: 'Bloque en curso que no se debe tocar',
      origin: 'plan',
      orderIndex: 900,
    },
  });
  const done = await prisma.studyBlock.create({
    data: {
      userId: USER_ID,
      topicId: topic.id,
      date: dayStart,
      durationMinutes: 25,
      technique: 'recall',
      status: 'completada',
      isCompleted: true,
      objective: 'Bloque completado que no se debe tocar',
      origin: 'plan',
      orderIndex: 901,
    },
  });
  fixtureIds = [running.id, done.id];

  await ensureTodayPlan(USER_ID, now);

  const afterRunning = await prisma.studyBlock.findUnique({ where: { id: running.id } });
  const afterDone = await prisma.studyBlock.findUnique({ where: { id: done.id } });
  assert.equal(afterRunning?.status, 'en_curso');
  assert.equal(afterRunning?.objective, 'Bloque en curso que no se debe tocar');
  assert.equal(afterDone?.status, 'completada');
  assert.equal(afterDone?.isCompleted, true);

  console.log('\n  ✅ ensureTodayPlan: un plan, sin duplicados y sin tocar lo empezado\n');
}

main()
  .catch((error) => {
    console.error(`\n  ❌ ${error.message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (fixtureIds.length) {
      await prisma.studyBlock.deleteMany({ where: { id: { in: fixtureIds } } });
    }
    await prisma.$disconnect();
  });
