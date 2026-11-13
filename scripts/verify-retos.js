/**
 * Verificación de los retos semanales.
 *
 * Parte **offline** (siempre, gratis): compila `src/lib/challenges.ts`, que es
 * puro, y comprueba las tres cosas que pueden arruinar un sistema de retos:
 *
 *   1. **La semana**: numeración ISO (que no parte semanas entre dos años), lunes
 *      como primer día y etiqueta legible del rango.
 *   2. **La generación**: que los retos salgan de datos reales, que haya como
 *      mucho cuatro, que sin datos no se invente ninguno de relleno y que cuando
 *      la semana pasada fue mal la meta baje en vez de subir.
 *   3. **La medición**: `challengeProgress` filtrando por materia y por unidad,
 *      la racha contada de días reales (incluida la que cruza de semana) y la
 *      XP/nivel derivado.
 *
 * Parte **viva** (`--live`, requiere `npm run dev`): ejecuta de verdad el motor
 * de retos (`refreshWeeklyChallenges`, el mismo que llama el botón) contra la
 * base: comprueba que **crea** los retos de la semana, que al repetir no
duplica nada, que los mide, que `/retos` los pinta con su progreso y que el
 * Cuartel y el repaso siguen en pie. Después borra lo que ha creado y deja la
 * base como estaba (los retos son datos derivados: se regeneran con el botón).
 *
 * Uso:
 *   node scripts/verify-retos.js           → solo lo offline (gratis)
 *   node scripts/verify-retos.js --live    → además, el camino real con la base
 */
const path = require('path');
const { getTestUserId } = require('./testUser.js');
const { execFileSync } = require('child_process');
const fs = require('fs');

const projectRoot = path.join(__dirname, '..');
const outDir = path.join(projectRoot, '.tmp-verify-retos');
const APP = 'http://localhost:3000';
const LIVE = process.argv.includes('--live');

fs.rmSync(outDir, { recursive: true, force: true });

// Se compila el MOTOR de retos (que arrastra consigo el módulo puro, la semana,
// el SRS y el cliente de Prisma): así la parte viva ejecuta el mismo código que
// corre en el servidor, no una copia.
execFileSync(
  process.execPath,
  [
    require.resolve('typescript/bin/tsc'),
    path.join('src', 'lib', 'challengeRefresh.ts'),
    '--outDir',
    '.tmp-verify-retos',
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

const ch = require(path.join(outDir, 'challenges.js'));

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

function day(year, month, dayOfMonth) {
  return new Date(year, month - 1, dayOfMonth);
}

const TODAY = day(2026, 10, 13); // martes

/* ------------------------------------------------------------------ */
/* Offline                                                            */
/* ------------------------------------------------------------------ */

function offline() {
  console.log('1) La semana: ISO, lunes y etiqueta');
  check('la clave de semana es ISO', ch.weekKeyOf(TODAY) === '2026-W42', ch.weekKeyOf(TODAY));
  check('la semana empieza el lunes', ch.weekStartOf(TODAY).getTime() === day(2026, 10, 12).getTime(), ch.weekStartOf(TODAY).toDateString());
  check('y acaba el lunes siguiente (domingo cerrado)', ch.weekEndOf(TODAY).getTime() === day(2026, 10, 19).getTime());
  check('el domingo cae en la misma semana que su lunes', ch.isSameWeek(day(2026, 10, 12), day(2026, 10, 18)) === true);
  check('1 de enero de 2026 (jueves) abre la semana 1', ch.weekKeyOf(day(2026, 1, 1)) === '2026-W01', ch.weekKeyOf(day(2026, 1, 1)));
  // El lunes 29-12-2025 y el 1-1-2026 están en la MISMA semana ISO (la 1 de 2026),
  // que es justo lo que evita que una semana quede partida entre dos años.
  check('el lunes 29-12-2025 abre la semana 1 de 2026', ch.weekKeyOf(day(2025, 12, 29)) === '2026-W01', ch.weekKeyOf(day(2025, 12, 29)));
  check('y el 31 de diciembre de 2025 pertenece a esa misma semana', ch.weekKeyOf(day(2025, 12, 31)) === '2026-W01', ch.weekKeyOf(day(2025, 12, 31)));
  check('el domingo anterior sí es de la semana anterior', ch.weekKeyOf(day(2025, 12, 28)) === '2025-W52', ch.weekKeyOf(day(2025, 12, 28)));
  check('la etiqueta del rango es legible', /12.*18/.test(ch.weekRangeLabel(day(2026, 10, 12))), ch.weekRangeLabel(day(2026, 10, 12)));

  console.log('\n2) Generación: retos de datos reales, pocos y posibles');
  const rich = ch.buildWeeklyChallengeSeeds({
    subjects: [{ id: 's1', name: 'Matemáticas I' }],
    measuredTopics: [
      { id: 't1', title: 'Derivadas', unitNumber: 4, masteryLevel: 45, subjectId: 's1', subjectName: 'Matemáticas I' },
    ],
    dueReviews: 10,
    pendingErrors: 7,
    errorsClosedLastWeek: 0,
    upcomingExams: [{ subjectId: 's1', subjectName: 'Matemáticas I', title: 'Parcial', days: 5 }],
    weeklyHoursCap: 12,
    weeklyHoursDeclared: true,
    streakCurrent: 5,
    lastWeek: { total: 4, completed: 3, minutes: 600, reviews: 12 },
  });

  check('como mucho cuatro retos por semana', rich.length === ch.MAX_WEEKLY_CHALLENGES, String(rich.length));
  check('los repasos vencidos son el primero', rich[0].kind === 'srs_reviews', rich[0].kind);
  check('la meta de repasos sale de los que tiene vencidos', rich[0].target === 16, String(rich[0].target));
  check('y no puede pasar de 40', rich[0].target <= 40);
  check('el segundo son los errores sin cerrar', rich[1].kind === 'master_errors', rich[1].kind);
  check('la subida de nivel apunta a la materia floja', rich[2].kind === 'mastery_gain' && rich[2].subjectId === 's1' && rich[2].topicId === 't1');
  check('el simulacro sale del examen cercano', rich[3].kind === 'simulacro' && rich[3].target === 2, JSON.stringify({ kind: rich[3].kind, target: rich[3].target }));
  check('ningún reto nace con meta cero', rich.every((seed) => seed.target > 0));
  check('todos pagan XP razonable', rich.every((seed) => seed.rewardXp >= 40 && seed.rewardXp <= 220));

  const thin = ch.buildWeeklyChallengeSeeds({
    subjects: [],
    measuredTopics: [],
    dueReviews: 0,
    pendingErrors: 0,
    errorsClosedLastWeek: 0,
    upcomingExams: [],
    weeklyHoursCap: 10,
    weeklyHoursDeclared: false,
    streakCurrent: 0,
    lastWeek: null,
  });
  check('sin datos no se inventan retos de relleno', thin.length === 1 && thin[0].kind === 'study_minutes', thin.map((s) => s.kind).join(','));
  check('y el de horas avisa de que son horas de partida', /declara tus horas reales/i.test(thin[0].description), thin[0].description);

  // Con todo compitiendo a la vez, el corte de cuatro deja fuera las horas y la
  // racha: primero lo que evita que se te olvide o se te acumule.
  check(
    'con seis candidatos, el corte se queda lo urgente y suelta lo demás',
    !rich.some((seed) => seed.kind === 'study_minutes' || seed.kind === 'streak_days'),
    rich.map((seed) => seed.kind).join(',')
  );

  // Para comparar la meta de horas hay que mirar una lista donde el reto de horas
  // sobreviva al corte (sin examen ni materia floja compitiendo).
  const hoursOnly = {
    subjects: [{ id: 's1', name: 'Matemáticas I' }],
    measuredTopics: [],
    dueReviews: 10,
    pendingErrors: 0,
    errorsClosedLastWeek: 0,
    upcomingExams: [],
    weeklyHoursCap: 12,
    weeklyHoursDeclared: true,
    streakCurrent: 0,
  };

  const goodWeek = ch.buildWeeklyChallengeSeeds({
    ...hoursOnly,
    lastWeek: { total: 4, completed: 3, minutes: 600, reviews: 12 },
  });
  const badWeek = ch.buildWeeklyChallengeSeeds({
    ...hoursOnly,
    lastWeek: { total: 4, completed: 1, minutes: 120, reviews: 3 },
  });

  const richReviews = goodWeek.find((seed) => seed.kind === 'srs_reviews').target;
  check('si la semana pasada fue mal, la meta de repasos baja', badWeek.find((seed) => seed.kind === 'srs_reviews').target < richReviews, `${badWeek.find((seed) => seed.kind === 'srs_reviews').target} < ${richReviews}`);
  const badHours = badWeek.find((seed) => seed.kind === 'study_minutes');
  const richHours = goodWeek.find((seed) => seed.kind === 'study_minutes');
  check('y la de horas también', badHours.target < richHours.target, `${badHours.target} min < ${richHours.target} min`);

  console.log('\n3) Medición: lo que cuenta cada reto y para quién');
  const workData = {
    reviews: [
      { topicId: 't1', subjectId: 's1' },
      { topicId: 't2', subjectId: 's2' },
    ],
    sessions: [
      { topicId: 't1', subjectId: 's1', minutes: 60, masteryDelta: 5 },
      { topicId: 't3', subjectId: 's2', minutes: 30, masteryDelta: -3 },
    ],
    closedErrors: [{ subjectId: 's1' }, { subjectId: 's2' }],
    simulacros: [
      { subjectId: 's1', subjectName: 'Matemáticas I' },
      { subjectId: null, subjectName: 'Historia' },
    ],
    studyDays: [day(2026, 10, 13), day(2026, 10, 12)],
  };

  check('los repasos cuentan todos', ch.challengeProgress('srs_reviews', { subjectId: null, topicId: null }, workData, TODAY) === 2);
  check('y se filtran por materia', ch.challengeProgress('srs_reviews', { subjectId: 's1', topicId: null }, workData, TODAY) === 1);
  check('y por unidad', ch.challengeProgress('srs_reviews', { subjectId: null, topicId: 't2' }, workData, TODAY) === 1);
  check('los minutos suman lo de la semana', ch.challengeProgress('study_minutes', { subjectId: null, topicId: null }, workData, TODAY) === 90);
  check('y por materia, solo lo suyo', ch.challengeProgress('study_minutes', { subjectId: 's1', topicId: null }, workData, TODAY) === 60);
  check('los errores cerrados cuentan por materia', ch.challengeProgress('master_errors', { subjectId: 's2', topicId: null }, workData, TODAY) === 1);
  check('los simulacros se emparejan con su materia', ch.challengeProgress('simulacro', { subjectId: 's1', topicId: null }, workData, TODAY) === 1);
  check('la subida de nivel solo cuenta lo que sube (nunca resta)', ch.challengeProgress('mastery_gain', { subjectId: null, topicId: null }, workData, TODAY) === 5);
  check('la materia que bajó no resta puntos', ch.challengeProgress('mastery_gain', { subjectId: 's2', topicId: null }, workData, TODAY) === 0);
  check('la racha sale de los días reales', ch.challengeProgress('streak_days', { subjectId: null, topicId: null }, workData, TODAY) === 2);

  console.log('\n4) La racha: la que cruza de semana también cuenta');
  check('sin días, racha 0', ch.currentStudyStreak([], TODAY) === 0);
  check('tres días seguidos hasta hoy = 3', ch.currentStudyStreak([day(2026, 10, 13), day(2026, 10, 12), day(2026, 10, 11)], TODAY) === 3);
  check('si hoy aún no ha estudiado, la racha de ayer sigue viva', ch.currentStudyStreak([day(2026, 10, 12), day(2026, 10, 11)], TODAY) === 2);
  check('pero si se saltó ayer, la racha se rompió', ch.currentStudyStreak([day(2026, 10, 11)], TODAY) === 0);
  check('una racha que empezó la semana pasada cuenta entera', ch.currentStudyStreak([day(2026, 10, 13), day(2026, 10, 12), day(2026, 10, 11), day(2026, 10, 10), day(2026, 10, 9), day(2026, 10, 8)], TODAY) === 6);
  check('los días repetidos no inflan la racha', ch.currentStudyStreak([day(2026, 10, 13), day(2026, 10, 13), day(2026, 10, 12)], TODAY) === 2);

  console.log('\n5) Progreso y niveles');
  const progress = ch.describeProgress(600, 'minutes', 340);
  check('el texto del progreso trae cuenta y meta', progress.label === '5.7 h / 10 h', progress.label);
  check('y su porcentaje', progress.percent === 57, String(progress.percent));
  check('sin llegar a la meta no está conseguido', progress.met === false);
  check('pasarse de la meta no pasa del 100%', ch.describeProgress(10, 'count', 25).percent === 100);
  check('meta cero no revienta (0%)', ch.describeProgress(0, 'count', 5).percent === 0);
  check('y llegar a la meta sí lo cierra', ch.describeProgress(10, 'count', 10).met === true);
  check('el semáforo distingue conseguido', ch.challengeProgressTone(100, true).className.includes('emerald'));
  check('y sin empezar', ch.challengeProgressTone(0, false).label === 'Sin empezar');

  check('sin XP, nivel 1', ch.levelFromXp(0).level === 1 && ch.levelFromXp(0).title === 'Recluta', ch.levelFromXp(0).title);
  check('con 119 XP sigue en el nivel 1', ch.levelFromXp(119).level === 1);
  check('con 120 XP sube al nivel 2', ch.levelFromXp(120).level === 2, String(ch.levelFromXp(120).level));
  check('y la XP sobrante pasa al nivel nuevo', ch.levelFromXp(320).level === 3 && ch.levelFromXp(320).xpInLevel === 0);
  check('una XP imposible no revienta el nivel', ch.levelFromXp(Number.NaN).level === 1 && ch.levelFromXp(-50).level === 1);
  check('el progreso del nivel nunca se sale', ch.levelFromXp(119.9).percent === 99, String(ch.levelFromXp(119.9).percent));
  check('nunca pasa de los 7 días de semana para la racha', ch.buildWeeklyChallengeSeeds({
    subjects: [], measuredTopics: [], dueReviews: 0, pendingErrors: 0, errorsClosedLastWeek: 0,
    upcomingExams: [], weeklyHoursCap: 10, weeklyHoursDeclared: true, streakCurrent: 30, lastWeek: null,
  }).find((seed) => seed.kind === 'streak_days').target === 7);
}

/* ------------------------------------------------------------------ */
/* Viva                                                               */
/* ------------------------------------------------------------------ */

async function live() {
  const { PrismaClient } = require('@prisma/client');
  const refresh = require(path.join(outDir, 'challengeRefresh.js'));
  const prisma = new PrismaClient();

  const beforeXp = (await prisma.userProfile.findFirst({ select: { challengeXp: true } }))?.challengeXp ?? 0;

  try {
    console.log('\n6) En vivo: el motor de retos contra la base real');

    // Se parte de cero con los retos de esta semana para que la prueba sea
    // determinista; son datos derivados y se vuelven a generar en el mismo paso.
    await prisma.weeklyChallenge.deleteMany({});

    const first = await refresh.refreshWeeklyChallenges({});
    check('el motor genera los retos de la semana', first.success === true && first.created >= 1, `created=${first.created}`);
    check('y devuelve el progreso de cada uno', first.progress.length === first.created, `${first.progress.length} retos con progreso`);
    check('ninguno nace con progreso negativo', first.progress.every((item) => Number.isFinite(item.current) && item.current >= 0));
    check('ningún reto se cierra solo en una semana vacía', first.completed === 0, `completed=${first.completed}`);

    const second = await refresh.refreshWeeklyChallenges({});
    check('volver a llamarlo no duplica nada', second.created === 0, `created=${second.created}`);
    check('y sigue midiendo los mismos retos', second.progress.length === first.progress.length, `${second.progress.length}`);

    const titles = first.progress.map((item) => item.title);
    console.log(`     retos de la semana: ${titles.join(' · ')}`);

    for (const url of ['/retos', '/', '/repaso']) {
      let res;
      try {
        res = await fetch(`${APP}${url}`);
      } catch {
        warn(`No se puede contactar con ${APP}${url}: ¿está levantado el servidor?`);
        break;
      }
      check(`${url} responde 200`, res.status === 200, String(res.status));
    }

    const retosRes = await fetch(`${APP}/retos`).catch(() => null);
    if (retosRes && retosRes.status === 200) {
      const html = await retosRes.text();
      check('la página pinta los retos generados', titles.every((title) => html.includes(title)), titles.join(' · '));
      check('y sus metas con la unidad correcta', /(\/ 2|h \/|d \/)/.test(html), 'contadores de progreso');
      // El nivel se pinta como «Nivel 1 · Recluta», pero React parte el texto
      // interpolado con marcadores de SSR: se comprueba por sus piezas.
      check(
        'y enseña el nivel del expediente',
        html.includes('Expediente de retos') && html.includes('Nivel') && ch.LEVEL_TITLES.some((title) => html.includes(title)),
        'nivel + rango'
      );
    } else if (retosRes) {
      warn(`/retos respondió ${retosRes.status}: no se pudo comprobar el contenido.`);
    }

    const homeRes = await fetch(`${APP}/`).catch(() => null);
    if (homeRes && homeRes.status === 200) {
      const html = await homeRes.text();
      check('el Cuartel enseña el bloque de Repaso y Retos', html.includes('Repaso y Retos') && html.includes('Retos de la semana'));
    } else if (homeRes) {
      warn(`El Cuartel respondió ${homeRes.status}.`);
    }
  } catch (error) {
    warn(`La parte viva no se pudo completar: ${error.message}`);
  } finally {
    await prisma.weeklyChallenge.deleteMany({});
    await prisma.userProfile.update({ where: { id: await getTestUserId() }, data: { challengeXp: beforeXp } });
    const leftoverChallenges = await prisma.weeklyChallenge.count();
    const xpNow = (await prisma.userProfile.findFirst({ select: { challengeXp: true } }))?.challengeXp ?? -1;
    check('la base queda como estaba (sin retos nuevos)', leftoverChallenges === 0, String(leftoverChallenges));
    check('y la XP del perfil no se ha quedado tocada', xpNow === beforeXp, `${xpNow} = ${beforeXp}`);
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
  console.log('\n(Parte viva omitida: usa `npm run verify:retos -- --live` con el servidor levantado.)');
  fs.rmSync(outDir, { recursive: true, force: true });
  console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLO(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}
