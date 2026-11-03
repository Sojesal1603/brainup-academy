/**
 * Verificación del Repaso Espaciado (SRS) y de la analítica de retención.
 *
 * Parte **offline** (siempre, gratis): compila `src/lib/srs.ts`, que es puro, y
 * comprueba lo que decide si el calendario es razonable:
 *
 *   1. La **programación**: primeros intervalos por valoración, crecimiento del
 *      intervalo al recordar, reinicio a un día al olvidar, topes de facilidad e
 *      intervalo, y que `again` nunca alarga nada.
 *   2. Los **vencimientos**: `nextReviewAt`, `daysUntilReview`, `overdueDays`,
 *      `isDue` sobre fechas construidas a mano (sin depender del día en que se
 *      ejecute la prueba).
 *   3. La **retención estimada**: `null` sin repasos, ~90% justo en la fecha
 *      prevista, decae con el tiempo y es mayor con más facilidad.
 *   4. La **cola**: sin historial no entra nadie; lo más vencido va primero y
 *      `onlyDue` filtra.
 *   5. La **analítica real**: tasa de recuerdo por tramo de intervalo, reparto
 *      por valoración y el estado honesto «todavía no hay repasos».
 *
 * Parte **viva** (`--live`, requiere `npm run dev`): crea una unidad y tres
 * repasos de prueba, comprueba que `/repaso` los pinta con sus datos y que el
 * Cuartel sigue respondiendo, y deja la base exactamente como estaba.
 *
 * Uso:
 *   node scripts/verify-srs.js           → solo lo offline (gratis)
 *   node scripts/verify-srs.js --live    → además, el camino real con la base
 */
const path = require('path');
const { execFileSync } = require('child_process');
const fs = require('fs');

const projectRoot = path.join(__dirname, '..');
const outDir = path.join(projectRoot, '.tmp-verify-srs');
const APP = 'http://localhost:3000';
const LIVE = process.argv.includes('--live');

fs.rmSync(outDir, { recursive: true, force: true });

execFileSync(
  process.execPath,
  [
    require.resolve('typescript/bin/tsc'),
    path.join('src', 'lib', 'srs.ts'),
    '--outDir',
    '.tmp-verify-srs',
    '--module',
    'commonjs',
    '--target',
    'es2022',
    '--moduleResolution',
    'node',
    '--skipLibCheck',
  ],
  { cwd: projectRoot, stdio: 'inherit' }
);

const srs = require(path.join(outDir, 'srs.js'));

let failures = 0;
const warnings = [];

function check(label, condition, detail) {
  if (condition) console.log(`  ✓ ${label}${detail ? ` · ${detail}` : ''}`);
  else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? ` · ${detail}` : ''}`);
  }
}

function warn(text) {
  warnings.push(text);
  console.log(`  ! ${text}`);
}

/** Fecha local a medianoche, para construirlas a mano. */
function day(year, month, dayOfMonth) {
  return new Date(year, month - 1, dayOfMonth);
}

function daysAgo(from, n) {
  const copy = new Date(from);
  copy.setDate(copy.getDate() - n);
  return copy;
}

/* ------------------------------------------------------------------ */
/* Offline                                                            */
/* ------------------------------------------------------------------ */

function offline() {
  const TODAY = day(2026, 10, 13);

  console.log('1) Programación: primeros intervalos, crecimiento y reinicio');
  const first = (rating) =>
    srs.applySrsReview({ intervalDays: 1, easeFactor: 2.5, lastReviewedAt: null }, rating, TODAY);

  check('sin historial, «otra vez» deja el repaso para mañana', first('again').intervalDays === 1);
  check('sin historial, «difícil» también es mañana', first('hard').intervalDays === 1);
  check('sin historial, «bien» son 2 días', first('good').intervalDays === 2);
  check('sin historial, «fácil» son 4 días', first('easy').intervalDays === 4);
  check(
    '«otra vez» baja la facilidad (cuesta retenerlo)',
    first('again').easeFactor < 2.5,
    String(first('again').easeFactor)
  );
  check('«fácil» sube la facilidad', first('easy').easeFactor > 2.5, String(first('easy').easeFactor));

  const grown = srs.applySrsReview(
    { intervalDays: 10, easeFactor: 2.5, lastReviewedAt: daysAgo(TODAY, 10) },
    'good',
    TODAY
  );
  check('con historial, «bien» multiplica el intervalo por la facilidad', grown.intervalDays === 25, String(grown.intervalDays));

  const stretched = srs.applySrsReview(
    { intervalDays: 10, easeFactor: 2.5, lastReviewedAt: daysAgo(TODAY, 10) },
    'easy',
    TODAY
  );
  check('«fácil» estira más que «bien»', stretched.intervalDays > grown.intervalDays, `${stretched.intervalDays} > ${grown.intervalDays}`);

  const reset = srs.applySrsReview(
    { intervalDays: 40, easeFactor: 2.5, lastReviewedAt: daysAgo(TODAY, 40) },
    'again',
    TODAY
  );
  check('«otra vez» reinicia el intervalo a un día', reset.intervalDays === 1);
  check('y el repaso queda para mañana mismo', reset.nextReviewAt.getTime() === srs.startOfDay(daysAgo(TODAY, -1)).getTime());

  const capped = srs.applySrsReview(
    { intervalDays: 170, easeFactor: 2.8, lastReviewedAt: daysAgo(TODAY, 170) },
    'good',
    TODAY
  );
  check('el intervalo tiene techo (180 días)', capped.intervalDays === srs.SRS_MAX_INTERVAL_DAYS, String(capped.intervalDays));

  const easeCeiling = srs.applySrsReview(
    { intervalDays: 2, easeFactor: 2.8, lastReviewedAt: daysAgo(TODAY, 2) },
    'easy',
    TODAY
  );
  const easeFloor = srs.applySrsReview(
    { intervalDays: 2, easeFactor: 1.3, lastReviewedAt: daysAgo(TODAY, 2) },
    'again',
    TODAY
  );
  check('la facilidad respeta el techo (2.8)', easeCeiling.easeFactor === srs.SRS_MAX_EASE, String(easeCeiling.easeFactor));
  check('la facilidad respeta el suelo (1.3)', easeFloor.easeFactor === srs.SRS_MIN_EASE, String(easeFloor.easeFactor));

  console.log('\n2) Vencimientos: cuándo toca y cuánto se ha retrasado');
  const overdueTopic = { lastReviewedAt: daysAgo(TODAY, 5), srsIntervalDays: 3, srsEaseFactor: 2.5 };
  check('el próximo repaso es el último + el intervalo', srs.nextReviewAt(overdueTopic).getTime() === srs.startOfDay(daysAgo(TODAY, 2)).getTime());
  check('faltan -2 días (ya venció)', srs.daysUntilReview(overdueTopic, TODAY) === -2, String(srs.daysUntilReview(overdueTopic, TODAY)));
  check('lleva 2 días de retraso', srs.overdueDays(overdueTopic, TODAY) === 2, String(srs.overdueDays(overdueTopic, TODAY)));
  check('y por tanto toca repasarlo', srs.isDue(overdueTopic, TODAY) === true);

  const futureTopic = { lastReviewedAt: TODAY, srsIntervalDays: 6, srsEaseFactor: 2.5 };
  check('recién repasado no toca', srs.isDue(futureTopic, TODAY) === false);
  check('faltan 6 días', srs.daysUntilReview(futureTopic, TODAY) === 6, String(srs.daysUntilReview(futureTopic, TODAY)));
  check('sin historial no hay fecha ni vencimiento', srs.nextReviewAt({ lastReviewedAt: null, srsIntervalDays: 1, srsEaseFactor: 2.5 }) === null && srs.isDue({ lastReviewedAt: null, srsIntervalDays: 1, srsEaseFactor: 2.5 }, TODAY) === false);

  console.log('\n3) Retención estimada: la curva del olvido');
  check(
    'sin repasos no se estima nada (null, no 0)',
    srs.estimateRetention({ lastReviewedAt: null, srsIntervalDays: 1, srsEaseFactor: 2.5 }, TODAY) === null
  );
  const atInterval = srs.estimateRetention(
    { lastReviewedAt: daysAgo(TODAY, 3), srsIntervalDays: 3, srsEaseFactor: 2.5 },
    TODAY
  );
  check('justo en la fecha prevista se recuerda ~90%', atInterval === 90, `${atInterval}%`);
  const justReviewed = srs.estimateRetention(
    { lastReviewedAt: TODAY, srsIntervalDays: 3, srsEaseFactor: 2.5 },
    TODAY
  );
  check('recién repasado, retención máxima', justReviewed === 100, `${justReviewed}%`);
  const late = srs.estimateRetention(
    { lastReviewedAt: daysAgo(TODAY, 30), srsIntervalDays: 3, srsEaseFactor: 2.5 },
    TODAY
  );
  check('a los 30 días de un intervalo de 3 se ha perdido mucho', late < 45, `${late}%`);
  const highEase = srs.estimateRetention(
    { lastReviewedAt: daysAgo(TODAY, 10), srsIntervalDays: 5, srsEaseFactor: 2.8 },
    TODAY
  );
  const lowEase = srs.estimateRetention(
    { lastReviewedAt: daysAgo(TODAY, 10), srsIntervalDays: 5, srsEaseFactor: 1.3 },
    TODAY
  );
  check('la misma unidad con más facilidad se recuerda mejor', highEase > lowEase, `${highEase}% > ${lowEase}%`);
  check('el semáforo no exagera con lo no medido', srs.retentionTone(null).label === 'Sin repasar');
  check('y con 30% avisa de riesgo', srs.retentionTone(30).className.includes('rose'), srs.retentionTone(30).label);

  console.log('\n4) La cola de repaso');
  const queue = srs.buildReviewQueue(
    [
      { id: 'a', lastReviewedAt: daysAgo(TODAY, 5), srsIntervalDays: 3, srsEaseFactor: 2.5 },
      { id: 'b', lastReviewedAt: daysAgo(TODAY, 10), srsIntervalDays: 3, srsEaseFactor: 2.5 },
      { id: 'c', lastReviewedAt: null, srsIntervalDays: 1, srsEaseFactor: 2.5 },
      { id: 'd', lastReviewedAt: TODAY, srsIntervalDays: 6, srsEaseFactor: 2.5 },
    ],
    TODAY
  );
  check('las unidades sin calendario no entran en la cola', !queue.some((item) => item.topic.id === 'c'));
  check('entran las tres con historial', queue.length === 3, String(queue.length));
  check('la más vencida va primero', queue[0].topic.id === 'b', queue.map((i) => i.topic.id).join('>'));
  check('la vencida va marcada como «due»', queue[0].due === true && queue[0].overdue === 7);
  check('la futura no está vencida', queue.find((item) => item.topic.id === 'd').due === false);

  const onlyDue = srs.buildReviewQueue(
    [
      { id: 'a', lastReviewedAt: daysAgo(TODAY, 5), srsIntervalDays: 3, srsEaseFactor: 2.5 },
      { id: 'd', lastReviewedAt: TODAY, srsIntervalDays: 6, srsEaseFactor: 2.5 },
    ],
    TODAY,
    { onlyDue: true }
  );
  check('«solo lo vencido» filtra lo que aún no toca', onlyDue.length === 1 && onlyDue[0].topic.id === 'a');

  console.log('\n5) Analítica de retención: lo que de verdad has recordado');
  const rows = [
    { reviewedAt: daysAgo(TODAY, 20), rating: 'good', quality: 4, recalled: true, intervalBeforeDays: 1, intervalAfterDays: 2, easeAfter: 2.5, overdueDays: 0 },
    { reviewedAt: daysAgo(TODAY, 18), rating: 'again', quality: 0, recalled: false, intervalBeforeDays: 2, intervalAfterDays: 1, easeAfter: 1.6, overdueDays: 0 },
    { reviewedAt: daysAgo(TODAY, 12), rating: 'hard', quality: 3, recalled: true, intervalBeforeDays: 5, intervalAfterDays: 6, easeAfter: 2.4, overdueDays: 1 },
    { reviewedAt: daysAgo(TODAY, 6), rating: 'again', quality: 0, recalled: false, intervalBeforeDays: 20, intervalAfterDays: 1, easeAfter: 1.5, overdueDays: 3 },
    { reviewedAt: daysAgo(TODAY, 2), rating: 'easy', quality: 5, recalled: true, intervalBeforeDays: 40, intervalAfterDays: 90, easeAfter: 2.6, overdueDays: 0 },
  ];

  const buckets = srs.retentionBuckets(rows);
  const bucket = (key) => buckets.find((b) => b.key === key);
  check('un intervalo de 1 día cae en el tramo «1 día»', bucket('d1').reviews === 1 && bucket('d1').recallRate === 100);
  check('el tramo de 2-3 días registra el fallo', bucket('d2a3').recallRate === 0, JSON.stringify(bucket('d2a3').recallRate));
  check('el tramo de 2-4 semanas concentra el fallo', bucket('d15a30').recallRate === 0);
  check('los tramos sin repasos quedan sin dato (null, no 0%)', bucket('d8a14').recallRate === null && bucket('d8a14').reviews === 0);

  const analytics = srs.buildRetentionAnalytics(rows, TODAY);
  check('cuenta todos los repasos', analytics.totalReviews === 5);
  check('tasa de recuerdo real: 3 de 5', analytics.recallRate === 60 && analytics.recalled === 3, `${analytics.recallRate}%`);
  check('reparte por valoración', analytics.byRating.good === 1 && analytics.byRating.again === 2 && analytics.byRating.easy === 1);
  check('facilidad media calculada de verdad', Math.abs(analytics.avgEaseAfter - 2.12) < 0.02, String(analytics.avgEaseAfter));
  check('intervalo medio de lo que llevabas programado', analytics.avgIntervalDays === 13.6, String(analytics.avgIntervalDays));
  // Dentro de 14 días entran los repasos de hace 2, 6 y 12 días; los de 18 y 20 no.
  const inWindow = analytics.activity.reduce((acc, day) => acc + day.reviews, 0);
  check('la actividad de 14 días cuenta solo lo que cae dentro', analytics.activity.length === 14 && inWindow === 3, `repasos en ventana: ${inWindow}`);
  check('y un resumen que dice la verdad', /60%/.test(analytics.summary), analytics.summary);

  const empty = srs.buildRetentionAnalytics([], TODAY);
  check('sin repasos no hay dato (hasData false)', empty.hasData === false && empty.recallRate === null);
  check('y el resumen lo dice en lugar de enseñar un 0%', /todavía no hay ningún repaso/i.test(empty.summary), empty.summary);

  console.log('\n6) Prioridad para el planificador');
  check('sin calendario no aporta prioridad', srs.srsPriorityBonus({ lastReviewedAt: null, srsIntervalDays: 1, srsEaseFactor: 2.5 }, TODAY) === 0);
  check('lo que falta mucho no aporta prioridad', srs.srsPriorityBonus({ lastReviewedAt: TODAY, srsIntervalDays: 20, srsEaseFactor: 2.5 }, TODAY) === 0);
  const overdueBonus = srs.srsPriorityBonus({ lastReviewedAt: daysAgo(TODAY, 10), srsIntervalDays: 3, srsEaseFactor: 2.5 }, TODAY);
  check('lo vencido sube en la lista', overdueBonus > 0, String(overdueBonus));
  check('pero está acotado (no aplasta a un examen)', overdueBonus <= 26, String(overdueBonus));
}

/* ------------------------------------------------------------------ */
/* Viva                                                               */
/* ------------------------------------------------------------------ */

async function live() {
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();

  let subjectId = null;
  let topicId = null;

  try {
    console.log('\n7) En vivo: el calendario dentro de la app');

    // Sujeto y unidad de prueba, con un calendario ya vencido y tres repasos.
    const subject = await prisma.subject.create({
      data: { name: 'PRUEBA SRS', color: '#22d3ee', order: 9999 },
    });
    subjectId = subject.id;

    const topic = await prisma.topic.create({
      data: {
        subjectId: subject.id,
        title: 'PRUEBA SRS · unidad de calendario',
        unitNumber: 1,
        status: 'visto',
        lastReviewedAt: new Date(Date.now() - 5 * 86400000),
        srsIntervalDays: 3,
        srsEaseFactor: 2.5,
      },
    });
    topicId = topic.id;

    const base = Date.now() - 5 * 86400000;
    await prisma.srsReview.createMany({
      data: [
        { topicId: topic.id, subjectId: subject.id, reviewedAt: new Date(base - 86400000), rating: 'good', quality: 4, recalled: true, intervalBeforeDays: 1, intervalAfterDays: 2, easeAfter: 2.5, overdueDays: 0 },
        { topicId: topic.id, subjectId: subject.id, reviewedAt: new Date(base - 3 * 86400000), rating: 'again', quality: 0, recalled: false, intervalBeforeDays: 2, intervalAfterDays: 1, easeAfter: 1.6, overdueDays: 0 },
        { topicId: topic.id, subjectId: subject.id, reviewedAt: new Date(base - 5 * 86400000), rating: 'hard', quality: 3, recalled: true, intervalBeforeDays: 2, intervalAfterDays: 3, easeAfter: 2.4, overdueDays: 1 },
      ],
    });

    // La unidad está vencida de verdad: lo comprueba el mismo motor.
    const stored = await prisma.topic.findUnique({ where: { id: topic.id } });
    check('la unidad de prueba queda vencida', srs.isDue(stored) === true, `retraso: ${srs.overdueDays(stored)} días`);

    const pages = [
      { url: '/repaso', expect: ['Repaso Espaciado', 'Analítica de retención', 'Retención estimada media'] },
      { url: '/', expect: ['Repaso y Retos', 'Repasos de hoy'] },
      { url: '/retos', expect: ['Retos Semanales'] },
    ];

    for (const page of pages) {
      let res;
      try {
        res = await fetch(`${APP}${page.url}`);
      } catch {
        warn(`No se puede contactar con ${APP}${page.url}: ¿está levantado el servidor?`);
        break;
      }

      const html = await res.text();
      const missing = page.expect.filter((needle) => !html.includes(needle));
      check(`${page.url} responde 200`, res.status === 200, String(res.status));
      check(`${page.url} renderiza sus bloques`, missing.length === 0, missing.length ? `falta: ${missing.join(', ')}` : 'todos');
    }

    // El cuaderno y el planificador siguen en pie tras tocar el SRS.
    for (const url of ['/apuntes', '/temario', '/planificador']) {
      try {
        const res = await fetch(`${APP}${url}`);
        check(`${url} sigue respondiendo`, res.status === 200, String(res.status));
      } catch {
        warn(`No se pudo comprobar ${url} (servidor caído).`);
        break;
      }
    }

    // La analítica real, leída de la base como la lee la página.
    const storedReviews = await prisma.srsReview.findMany({
      where: { topicId: topic.id },
      select: {
        reviewedAt: true,
        rating: true,
        quality: true,
        recalled: true,
        intervalBeforeDays: true,
        intervalAfterDays: true,
        easeAfter: true,
        overdueDays: true,
      },
    });
    const analytics = srs.buildRetentionAnalytics(storedReviews);
    check('la analítica lee los repasos guardados', analytics.totalReviews === 3, String(analytics.totalReviews));
    check('y calcula la tasa de recuerdo (2 de 3)', analytics.recallRate === 67, `${analytics.recallRate}%`);
  } finally {
    // La base queda como estaba: se borra primero lo que depende de la unidad.
    if (topicId) {
      await prisma.srsReview.deleteMany({ where: { topicId } });
      await prisma.topic.delete({ where: { id: topicId } }).catch(() => {});
    }
    if (subjectId) {
      await prisma.subject.delete({ where: { id: subjectId } }).catch(() => {});
    }
    const leftovers = await prisma.topic.count({ where: { title: { startsWith: 'PRUEBA SRS' } } });
    check('la base queda limpia (sin unidades de prueba)', leftovers === 0, String(leftovers));
    await prisma.$disconnect();
  }
}

/* ------------------------------------------------------------------ */
/* Ejecución                                                          */
/* ------------------------------------------------------------------ */

offline();

if (LIVE) {
  live()
    .catch((error) => {
      failures += 1;
      console.error('  ✗ La parte viva falló:', error.message);
    })
    .finally(() => {
      fs.rmSync(outDir, { recursive: true, force: true });
      console.log(
        `\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLO(S)`}${warnings.length ? ` · ${warnings.length} aviso(s)` : ''}`
      );
      process.exit(failures === 0 ? 0 : 1);
    });
} else {
  console.log('\n(Parte viva omitida: usa `npm run verify:srs -- --live` con el servidor levantado.)');
  fs.rmSync(outDir, { recursive: true, force: true });
  console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLO(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}
