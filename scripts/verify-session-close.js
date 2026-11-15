/**
 * Verificación del cierre de sesión con el catedrático.
 *
 * Comprueba lo que el alumno nota: una sesión con dos fallos y dos tarjetas deja
 * exactamente dos fichas y dos tarjetas, marca el plan y, al repetir el cierre,
 * NO duplica nada. Usa una cuenta temporal y la borra al terminar (las cascadas
 * se llevan fichas, tarjetas y resultado).
 *
 * Se ejecuta contra la base real porque la idempotencia vive en un índice
 * único: simularla con objetos en memoria no probaría nada.
 *
 * Uso: node scripts/verify-session-close.js   (o npm run verify:cierre)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const projectRoot = path.join(__dirname, '..');

// El script corre fuera de Next: se carga el `.env` a mano, sin imprimir valores.
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
loadEnv();

const outDir = path.join(projectRoot, '.tmp-verify-session');
let failures = 0;
function check(label, condition, extra) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FALLO ${label}`, extra === undefined ? '' : extra);
  }
}

fs.rmSync(outDir, { recursive: true, force: true });
execFileSync(
  process.execPath,
  [
    require.resolve('typescript/bin/tsc'),
    path.join('src', 'lib', 'sessionClose.ts'),
    '--outDir',
    '.tmp-verify-session',
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

const { PrismaClient } = require('@prisma/client');
const { closeTutorSession } = require(path.join(outDir, 'sessionClose.js'));

const prisma = new PrismaClient();
const userId = crypto.randomUUID();
const sessionKey = `sesion:prueba:${Date.now()}`;

async function main() {
  console.log('Cierre de sesión: idempotencia y efectos');

  await prisma.userProfile.create({
    data: { id: userId, name: 'Prueba de cierre', setupCompletedAt: new Date() },
  });
  const subject = await prisma.subject.create({
    data: { userId, name: 'Materia de prueba', color: '#10b981' },
  });
  const topic = await prisma.topic.create({
    data: { userId, subjectId: subject.id, title: 'Unidad de prueba' },
  });

  const payload = {
    sessionKey,
    planId: null,
    subjectId: subject.id,
    topicId: topic.id,
    workedOn: ['Derivadas', 'Optimización'],
    pending: ['Regla de la cadena'],
    directSolutionCount: 1,
    errors: [
      {
        questionPrompt: '¿Derivada de ln(x²)?',
        myAnswer: '2/x²',
        correctAnswer: '2/x',
        rootCause: 'concepto',
        keyLesson: 'La regla de la cadena va de fuera adentro.',
        correctiveAction: 'Repetir cinco derivadas encadenadas sin apuntes.',
      },
      {
        questionPrompt: 'Máximo de A(x) = 4x√(25 − x²)',
        myAnswer: 'x = 5',
        correctAnswer: 'x = 5/√2',
        rootCause: 'calculo',
        keyLesson: 'Al derivar un producto con raíz se simplifica antes de igualar.',
        correctiveAction: 'Rehacer el ejercicio y comprobar la segunda derivada.',
      },
    ],
    cards: [
      { front: '¿Qué es una derivada?', back: 'La tasa de cambio instantánea.', kind: 'flashcard' },
      { front: 'Regla de la cadena', back: 'f(g(x))′ = f′(g(x))·g′(x).', kind: 'flashcard' },
    ],
  };

  const first = await closeTutorSession(userId, payload);
  check('el primer cierre no está ya cerrado', first.alreadyClosed === false);
  check('crea dos fichas en el Banco de Errores', first.errorsCreated === 2, first.errorsCreated);
  check('crea dos tarjetas', first.reviewCardsCreated === 2, first.reviewCardsCreated);
  check('invalida el plan', first.planInvalidated === true);

  const errors = await prisma.errorLog.count({ where: { userId } });
  const cards = await prisma.reviewCard.count({ where: { userId } });
  const outcomes = await prisma.tutorSessionOutcome.count({ where: { userId } });
  check('en la base hay exactamente 2 fichas', errors === 2, errors);
  check('en la base hay exactamente 2 tarjetas', cards === 2, cards);
  check('hay exactamente 1 resultado de sesión', outcomes === 1, outcomes);

  const card = await prisma.reviewCard.findFirst({ where: { userId }, orderBy: { front: 'asc' } });
  check('la tarjeta guarda su huella (frontHash)', Boolean(card.frontHash), card.frontHash);

  const plan = await prisma.planState.findFirst({ where: { userId } });
  check('el plan queda invalidado con motivo', plan?.status === 'invalidated', plan?.status);

  console.log('\nRepetir el cierre (doble clic o reintento de red)');
  const second = await closeTutorSession(userId, payload);
  check('se reconoce como ya cerrada', second.alreadyClosed === true);
  check('devuelve el mismo resultado', second.outcomeId === first.outcomeId);
  check('no inventa fichas nuevas', (await prisma.errorLog.count({ where: { userId } })) === 2);
  check('no duplica tarjetas', (await prisma.reviewCard.count({ where: { userId } })) === 2);
  check(
    'sigue habiendo un único resultado de sesión',
    (await prisma.tutorSessionOutcome.count({ where: { userId } })) === 1
  );

  console.log('\nValidación de entrada');
  let rejected = false;
  try {
    await closeTutorSession(userId, { ...payload, sessionKey: `${sessionKey}:otro`, topicId: '' });
  } catch (error) {
    rejected = /inválido/i.test(String(error.message));
  }
  check('rechaza un cierre sin tema antes de escribir nada', rejected);
  check(
    'el rechazo no dejó fichas de más',
    (await prisma.errorLog.count({ where: { userId } })) === 2
  );

  let badCause = false;
  try {
    await closeTutorSession(userId, {
      ...payload,
      sessionKey: `${sessionKey}:causa`,
      errors: [{ ...payload.errors[0], rootCause: 'inventada' }],
    });
  } catch {
    badCause = true;
  }
  check('rechaza una causa de fallo que no existe', badCause);
}

main()
  .catch((error) => {
    failures += 1;
    console.error('\nERROR:', error instanceof Error ? error.message : error);
  })
  .finally(async () => {
    await prisma.userProfile.delete({ where: { id: userId } }).catch(() => {});
    await prisma.$disconnect();
    fs.rmSync(outDir, { recursive: true, force: true });
    console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLO(S)`}`);
    process.exit(failures === 0 ? 0 : 1);
  });
