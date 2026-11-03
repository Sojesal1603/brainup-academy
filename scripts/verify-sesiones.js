/**
 * Verificación del motor de sesiones (`src/lib/sessionEngine.ts`).
 *
 * Se transpila el módulo de verdad, no una copia: si alguien cambia las reglas,
 * esto lo nota. Todo es puro (sin base de datos, sin red, sin gastar IA):
 *
 *   1. **Duraciones**: las únicas permitidas, su descanso y su tramo.
 *   2. **Estimación por fases**: dificultad, nivel medido o no, errores, examen
 *      próximo, calibración aprendida y lo que ya está hecho.
 *   3. **Calibración**: la mediana del historial, con pocas muestras no se
 *      aprende nada y sin valores absurdos.
 *   4. **Encaje**: nunca se propone más tiempo del disponible ni sesiones de
 *      menos de 10 minutos; con poco tiempo, una sesión corta de alto valor.
 *   5. **Descansos**: proporcionales a la duración, no 25/5 para todo.
 *   6. **Reprogramación y recuperación**: lo que no se hace vuelve al siguiente
 *      hueco sin repetir lo hecho; tras varios días parado, plan de vuelta.
 *   7. **FSRS**: 90% de recuerdo justo en la estabilidad, intervalos que crecen
 *      al recordar y vuelven a un día al fallar, riesgo calculado el día del
 *      examen.
 *
 * Uso: `node scripts/verify-sesiones.js`
 */
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'sessionEngine.ts'), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

const module_ = { exports: {} };
// `sessionEngine` solo importa tipos de `./types`, que el transpilador borra.
new Function('exports', 'module', 'require', js)(module_.exports, module_, require);
const E = module_.exports;

// La lectura del avance de clase también es pura: se prueba igual.
const classSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'classCheckIn.ts'), 'utf8');
const classJs = ts.transpileModule(classSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const classModule = { exports: {} };
new Function('exports', 'module', 'require', classJs)(classModule.exports, classModule, require);
const C = classModule.exports;

let failures = 0;
let checks = 0;

function check(label, condition, detail = '') {
  checks += 1;
  if (condition) {
    console.log(`  ✓ ${label}${detail ? ` · ${detail}` : ''}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? ` · ${detail}` : ''}`);
  }
}

function day(year, month, dayOfMonth) {
  return new Date(year, month - 1, dayOfMonth, 9, 0, 0);
}

function daysAgo(from, n) {
  const copy = new Date(from);
  copy.setDate(copy.getDate() - n);
  return copy;
}

function work(comprension, practica, repaso, correccion, simulacro) {
  const total = comprension + practica + repaso + correccion + simulacro;
  return {
    comprension,
    practica,
    repaso,
    correccion,
    simulacro,
    rawTotal: total,
    total,
    calibration: 1,
    assumptions: [],
  };
}

let seq = 0;
function candidate(overrides = {}) {
  seq += 1;
  return {
    topicId: `t${seq}`,
    topicTitle: `Unidad ${seq}`,
    subjectId: overrides.subjectId ?? `s${seq}`,
    subjectName: 'Materia',
    subjectColor: '#10b981',
    priority: overrides.priority ?? 50,
    work: overrides.work ?? work(30, 30, 0, 0, 0),
    difficulty: overrides.difficulty ?? 3,
    mastery: overrides.mastery ?? 50,
    measured: overrides.measured ?? true,
    daysToExam: overrides.daysToExam ?? null,
    examWeight: overrides.examWeight ?? 0.2,
    examTitle: overrides.examTitle ?? null,
    dueReview: overrides.dueReview ?? false,
    overdueDays: overrides.overdueDays ?? 0,
    retention: overrides.retention ?? null,
    retentionAtExam: null,
    errorsOpen: overrides.errorsOpen ?? 0,
    status: overrides.status ?? 'visto',
    seen: true,
    taskDays: overrides.taskDays ?? null,
    classNextDay: overrides.classNextDay ?? false,
    seenToday: overrides.seenToday ?? false,
  };
}

/* ------------------------------------------------------------------ */

console.log('\n1 · Duraciones permitidas y descansos');
{
  check(
    'solo existen 10, 15, 25, 40, 50, 60 y 90',
    JSON.stringify(E.SESSION_LENGTHS) === JSON.stringify([10, 15, 25, 40, 50, 60, 90]),
    JSON.stringify(E.SESSION_LENGTHS)
  );
  check('15 minutos son micro-sesión', E.bucketForMinutes(15) === 'micro');
  check('25 es la sesión estándar', E.bucketForMinutes(25) === 'estandar');
  check('40 y 50 son bloque profundo', E.bucketForMinutes(40) === 'profundo' && E.bucketForMinutes(50) === 'profundo');
  check('60 y 90 son intensivos', E.bucketForMinutes(60) === 'intensivo' && E.bucketForMinutes(90) === 'intensivo');
  check('una micro-sesión no lleva 5 minutos de descanso', E.breakForMinutes(15) === 3);
  check('25 minutos llevan 5 de descanso', E.breakForMinutes(25) === 5);
  check('40-50 llevan 8-10 de descanso', E.breakForMinutes(40) === 9 && E.breakForMinutes(50) === 9);
  check('90 llevan un descanso más largo (15)', E.breakForMinutes(90) === 15);
  check('el descanso crece con la duración', E.breakForMinutes(15) < E.breakForMinutes(25) && E.breakForMinutes(50) < E.breakForMinutes(90));
}

console.log('\n2 · Estimación por fases');
{
  const base = E.estimateTopicWork({
    difficulty: 3,
    mastery: 50,
    measured: false,
    errorsOpen: 0,
    daysToExam: null,
    examWeight: 0.2,
    targetGrade: 9,
  });
  check('sin datos se estima igualmente (y se dice qué se ha supuesto)', base.total > 0 && base.assumptions.length >= 3, `${base.total} min · ${base.assumptions.length} supuestos`);
  check('las cinco fases se calculan por separado', ['comprension', 'practica', 'repaso', 'correccion', 'simulacro'].every((key) => typeof base[key] === 'number'));
  check('comprensión y práctica son lo que más pesa', base.comprension > 0 && base.practica > 0);
  check('sin examen próximo no hay simulacro', base.simulacro === 0);

  const facil = E.estimateTopicWork({ difficulty: 1, mastery: 50, measured: true, errorsOpen: 0, daysToExam: null, examWeight: 0, targetGrade: 9 });
  const dificil = E.estimateTopicWork({ difficulty: 5, mastery: 50, measured: true, errorsOpen: 0, daysToExam: null, examWeight: 0, targetGrade: 9 });
  check('un tema difícil cuesta más que uno fácil', dificil.total > facil.total, `${dificil.total} > ${facil.total}`);

  const flojo = E.estimateTopicWork({ difficulty: 3, mastery: 20, measured: true, errorsOpen: 0, daysToExam: null, examWeight: 0, targetGrade: 9 });
  const fuerte = E.estimateTopicWork({ difficulty: 3, mastery: 90, measured: true, errorsOpen: 0, daysToExam: null, examWeight: 0, targetGrade: 9 });
  check('un tema flojo medido cuesta más que uno dominado', flojo.total > fuerte.total, `${flojo.total} > ${fuerte.total}`);

  const sinMedir = E.estimateTopicWork({ difficulty: 3, mastery: 0, measured: false, errorsOpen: 0, daysToExam: null, examWeight: 0, targetGrade: 9 });
  const medidoCero = E.estimateTopicWork({ difficulty: 3, mastery: 0, measured: true, errorsOpen: 0, daysToExam: null, examWeight: 0, targetGrade: 9 });
  check('un tema sin medir NO se trata como un 0% (nivel neutro)', sinMedir.total < medidoCero.total, `${sinMedir.total} < ${medidoCero.total}`);

  const conErrores = E.estimateTopicWork({ difficulty: 3, mastery: 50, measured: true, errorsOpen: 4, daysToExam: null, examWeight: 0, targetGrade: 9 });
  const sinErrores = E.estimateTopicWork({ difficulty: 3, mastery: 50, measured: true, errorsOpen: 0, daysToExam: null, examWeight: 0, targetGrade: 9 });
  check('los errores abiertos añaden corrección', conErrores.correccion > sinErrores.correccion, `${conErrores.correccion} min`);
  check('sin errores abiertos NO hay fase de corrección', sinErrores.correccion === 0, String(sinErrores.correccion));

  const sinErroresPlan = E.planSessions(
    [candidate({ errorsOpen: 0, work: sinErrores })],
    40
  );
  check('y la primera sesión no es «cerrar 0 errores»', sinErroresPlan.every((s) => s.stage !== 'correccion'), sinErroresPlan.map((s) => s.stage).join(','));

  const conExamen = E.estimateTopicWork({ difficulty: 3, mastery: 50, measured: true, errorsOpen: 0, daysToExam: 3, examWeight: 0.2, targetGrade: 9 });
  check('con examen a 3 días aparece simulacro', conExamen.simulacro > 0, `${conExamen.simulacro} min`);
  const examenLejos = E.estimateTopicWork({ difficulty: 3, mastery: 50, measured: true, errorsOpen: 0, daysToExam: 40, examWeight: 0.2, targetGrade: 9 });
  check('con el examen a 40 días no toca simulacro', examenLejos.simulacro === 0);

  const calibrado = E.estimateTopicWork({ difficulty: 3, mastery: 50, measured: true, errorsOpen: 0, daysToExam: null, examWeight: 0, targetGrade: 9, calibration: 1.5 });
  const sinCalibrar = E.estimateTopicWork({ difficulty: 3, mastery: 50, measured: true, errorsOpen: 0, daysToExam: null, examWeight: 0, targetGrade: 9, calibration: 1 });
  check('si el historial dice que tardas más, la estimación sube', calibrado.total > sinCalibrar.total, `${calibrado.total} > ${sinCalibrar.total}`);

  const avanzado = E.estimateTopicWork({ difficulty: 3, mastery: 50, measured: true, errorsOpen: 0, daysToExam: null, examWeight: 0, targetGrade: 9, minutesAlready: 120 });
  check('lo ya estudiado se descuenta (no se cobra dos veces)', avanzado.comprension + avanzado.practica < sinCalibrar.comprension + sinCalibrar.practica, `${avanzado.comprension + avanzado.practica} < ${sinCalibrar.comprension + sinCalibrar.practica}`);

  const conSeñales = E.estimateTopicWork({
    difficulty: 3,
    mastery: 50,
    measured: true,
    errorsOpen: 0,
    daysToExam: null,
    examWeight: 0,
    targetGrade: 9,
    signals: { pages: 30, slides: 40, concepts: 12, exercises: 20, classMinutes: 300 },
  });
  check('con páginas, conceptos y ejercicios la estimación se afina', conSeñales.total > base.total, `${conSeñales.total} > ${base.total}`);
  check('y ya no avisa de datos que sí tiene', conSeñales.assumptions.length === 0, conSeñales.assumptions.join(', ') || 'sin avisos');
}

console.log('\n3 · Calibración con el historial');
{
  check('sin muestras no se aprende nada (1)', E.calibrationByTechnique([]).default === 1);

  const pocas = E.calibrationByTechnique([
    { technique: 'problemas', plannedMinutes: 25, spentMinutes: 50 },
    { technique: 'problemas', plannedMinutes: 25, spentMinutes: 50 },
  ]);
  check('con dos muestras todavía no se calibra', pocas.problemas === undefined);

  const tres = E.calibrationByTechnique([
    { technique: 'problemas', plannedMinutes: 25, spentMinutes: 40 },
    { technique: 'problemas', plannedMinutes: 25, spentMinutes: 38 },
    { technique: 'problemas', plannedMinutes: 40, spentMinutes: 60 },
  ]);
  check('con tres muestras se aprende el desvío real (≈1.5)', Math.abs(tres.problemas - 1.5) < 0.06, String(tres.problemas));

  const exagerado = E.calibrationByTechnique([
    { technique: 'srs_review', plannedMinutes: 25, spentMinutes: 75 },
    { technique: 'srs_review', plannedMinutes: 25, spentMinutes: 75 },
    { technique: 'srs_review', plannedMinutes: 25, spentMinutes: 75 },
  ]);
  check('el desvío se acota (tope 1.8) aunque el historial diga el triple', exagerado.srs_review === 1.8, String(exagerado.srs_review));

  const olvidado = E.calibrationByTechnique([
    { technique: 'simulacro', plannedMinutes: 25, spentMinutes: 200 },
    { technique: 'simulacro', plannedMinutes: 25, spentMinutes: 200 },
    { technique: 'simulacro', plannedMinutes: 25, spentMinutes: 200 },
  ]);
  check('un temporizador olvidado se descarta, no se aprende de él', olvidado.simulacro === undefined);

  const absurdo = E.calibrationByTechnique([
    { technique: 'flashcards', plannedMinutes: 25, spentMinutes: 1 },
    { technique: 'flashcards', plannedMinutes: 25, spentMinutes: 1 },
    { technique: 'flashcards', plannedMinutes: 25, spentMinutes: 1 },
  ]);
  check('las muestras imposibles se descartan', absurdo.flashcards === undefined);

  check('la técnica sin datos usa el valor por defecto', E.calibrationFor(tres, 'simulacro') === 1);
}

console.log('\n4 · Encaje exacto en el tiempo disponible');
{
  check('45 minutos disponibles con un tema enorme dan un bloque de 40-50', [40, 50].includes(E.chooseDuration(45, 200)), String(E.chooseDuration(45, 200)));
  check('nunca propone más que el tiempo disponible', E.chooseDuration(20, 200) <= 20, String(E.chooseDuration(20, 200)));
  check('con 12 minutos propone una micro-sesión de 10', E.chooseDuration(12, 200) === 10, String(E.chooseDuration(12, 200)));
  check('con 5 minutos no propone nada', E.chooseDuration(5, 200) === null);
  check('un bloque de 90 no se ofrece con la energía baja', E.chooseDuration(100, 300, 'baja') < 60, String(E.chooseDuration(100, 300, 'baja')));
  check('pero sí con energía normal', E.chooseDuration(100, 300, 'media') === 90);
  check('no se ofrece un bloque de 90 para 10 minutos de trabajo', E.chooseDuration(100, 10) <= 25, String(E.chooseDuration(100, 10)));

  const unico = [candidate({ work: work(60, 120, 30, 0, 0) })];
  const plan45 = E.planSessions(unico, 45);
  const sum45 = plan45.reduce((acc, session) => acc + session.durationMinutes, 0);
  check('la suma de sesiones nunca pasa del tiempo disponible', sum45 <= 45, `${sum45} min de 45`);
  check('todas las duraciones son de la lista permitida', plan45.every((session) => E.SESSION_LENGTHS.includes(session.durationMinutes)), plan45.map((s) => s.durationMinutes).join('+'));
  check('ninguna sesión baja de 10 minutos', plan45.every((session) => session.durationMinutes >= E.MIN_SESSION_MINUTES));
  check('con 45 minutos no se montan más de 2 sesiones', plan45.length <= 2, String(plan45.length));

  const plan90 = E.planSessions([candidate({ work: work(90, 180, 60, 0, 0) })], 90);
  check('con 90 minutos y mucho trabajo se puede llegar al bloque intensivo', plan90.some((s) => s.durationMinutes >= 60), plan90.map((s) => s.durationMinutes).join('+'));

  const planCorto = E.planSessions([candidate({ work: work(200, 400, 100, 0, 0) })], 12);
  check('con 12 minutos propone UNA sesión corta de alto valor', planCorto.length === 1 && planCorto[0].durationMinutes === 10);
  check('y esa sesión trae su motivo', typeof planCorto[0].reason === 'string' && planCorto[0].reason.length > 10, planCorto[0].reason);

  check('sin tiempo útil no se propone nada', E.planSessions([candidate()], 5).length === 0);

  const muchas = [
    candidate({ subjectId: 'mate', priority: 90, work: work(100, 200, 0, 0, 0) }),
    candidate({ subjectId: 'fisica', priority: 80, work: work(100, 200, 0, 0, 0) }),
    candidate({ subjectId: 'lengua', priority: 70, work: work(100, 200, 0, 0, 0) }),
  ];
  const planMaterias = E.planSessions(muchas, 200, { maxSessions: 3 });
  check('no se repite materia si hay otras con trabajo', new Set(planMaterias.map((s) => s.candidate.subjectId)).size === planMaterias.length, planMaterias.map((s) => s.candidate.subjectId).join(' > '));
  check('el techo de sesiones se respeta', planMaterias.length <= 3, String(planMaterias.length));
}

console.log('\n5 · Descansos y microtareas');
{
  const plan = E.planSessions([candidate({ work: work(100, 200, 0, 0, 0) })], 50);
  check('cada sesión lleva su descanso', plan.every((session) => session.breakMinutes >= 3));
  check('una sesión de 50 no lleva los 5 minutos del pomodoro clásico', plan[0].breakMinutes !== 5, `${plan[0].breakMinutes} min`);

  const micros = E.microTasks({ errorsOpen: 3, dueReviews: 2 });
  check('ofrece microtareas de 5-10 minutos', micros.length >= 3 && micros.every((task) => task.minutes <= 10), micros.map((m) => m.minutes).join(', '));
  check('van ordenadas de la más corta a la más larga', micros.every((task, i) => i === 0 || micros[i - 1].minutes <= task.minutes));
  check('el último error aparece si lo hay', micros.some((task) => /error/i.test(task.label)));
  check('sin errores no se inventa ese trabajo', !E.microTasks({ errorsOpen: 0 }).some((task) => /error/i.test(task.label)));
}

console.log('\n6 · Reprogramación y plan de recuperación');
{
  const aMedias = E.rescheduleSession({ durationMinutes: 40, spentMinutes: 15 });
  check('una sesión a medias vuelve con lo que faltaba', aMedias.keep && aMedias.minutesLeft === 25, String(aMedias.minutesLeft));
  const casi = E.rescheduleSession({ durationMinutes: 40, spentMinutes: 35 });
  check('si faltaba menos de 10 minutos, se da por cerrada', casi.keep === false);
  const abandonada = E.rescheduleSession({ durationMinutes: 40, spentMinutes: 0, abandonCount: 3 });
  check('abandonada tres veces deja de reprogramarse', abandonada.keep === false, abandonada.note);

  check('sin historial no hay plan de recuperación', E.recoveryPlan(null).active === false);
  check('dos días sin estudiar es ritmo normal', E.recoveryPlan(2).active === false);
  const corto = E.recoveryPlan(4);
  check('cuatro días parado activa recuperación de 2 sesiones', corto.active === true && corto.maxSessions === 2, String(corto.maxSessions));
  const largo = E.recoveryPlan(9);
  check('una semana parado empieza con una sola sesión', largo.active === true && largo.maxSessions === 1);
  check('y lo explica en lugar de esconderlo', /recuperación/i.test(largo.detail), largo.headline);

  const recuperacion = E.planSessions(
    [candidate({ work: work(100, 200, 100, 0, 0) }), candidate({ work: work(100, 200, 100, 0, 0) })],
    240,
    { recovery: true }
  );
  check('el plan de recuperación no llena la tarde', recuperacion.length <= 2, String(recuperacion.length));
}

console.log('\n7 · Repaso adaptativo (FSRS)');
{
  const TODAY = day(2026, 11, 2);
  check('recién repasado el recuerdo es máximo', Math.round(E.retrievability(10, 0) * 100) === 100, `${E.retrievability(10, 0)}`);
  check('al llegar a la estabilidad el recuerdo es el 90%', Math.round(E.retrievability(10, 10) * 100) === 90, `${(E.retrievability(10, 10) * 100).toFixed(1)}%`);
  check('el intervalo para el 90% es la estabilidad', E.intervalForRetention(10, 0.9) === 10, String(E.intervalForRetention(10, 0.9)));
  check('pedir el 85% alarga el repaso', E.intervalForRetention(10, 0.85) > 10, String(E.intervalForRetention(10, 0.85)));
  check('pedir el 95% lo acorta', E.intervalForRetention(10, 0.95) < 10, String(E.intervalForRetention(10, 0.95)));

  const initial = E.initFsrsState('good');
  check('la primera vez la memoria es corta (días)', initial.stability > 0 && initial.stability < 10, String(initial.stability));
  check('y la dificultad queda en la escala 1-10', initial.difficulty >= 1 && initial.difficulty <= 10, String(initial.difficulty));

  const base = { stability: 10, difficulty: 5, lastReviewedAt: daysAgo(TODAY, 10) };
  const bien = E.scheduleFsrs(base, 'good', TODAY);
  const facil = E.scheduleFsrs(base, 'easy', TODAY);
  const mal = E.scheduleFsrs(base, 'again', TODAY);
  check('recordar con soltura aumenta la estabilidad', bien.stability > base.stability, `${base.stability} → ${bien.stability}`);
  check('«fácil» estira más que «bien»', facil.stability > bien.stability, `${facil.stability} > ${bien.stability}`);
  check('fallar la reduce', mal.stability < base.stability, `${mal.stability}`);
  check('y el repaso vuelve al día siguiente', mal.intervalDays === 1);
  check('recordar retrasa el siguiente repaso', bien.intervalDays > 1, `${bien.intervalDays} días`);
  check('el siguiente repaso nunca cae antes de mañana', bien.intervalDays >= 1);
  check('el momento del repaso queda registrado (0-1)', bien.retrievabilityAtReview >= 0 && bien.retrievabilityAtReview <= 1, String(bien.retrievabilityAtReview));

  const sinHistorial = E.recallAtExam({ stability: 10, lastReviewedAt: null }, new Date(2026, 10, 20), TODAY);
  check('sin repasos no se inventa una probabilidad', sinHistorial === null);

  const cerca = E.recallAtExam({ stability: 10, lastReviewedAt: TODAY }, new Date(2026, 10, 5), TODAY);
  const lejos = E.recallAtExam({ stability: 10, lastReviewedAt: TODAY }, new Date(2026, 10, 25), TODAY);
  check('cuanto más lejos el examen, menos recuerdo', lejos < cerca, `${lejos}% < ${cerca}%`);
  check('el examen de dentro de 3 días se recuerda alto', cerca >= 85, `${cerca}%`);

  check(
    'avisa de repasar si al examen se llega por debajo del objetivo',
    E.needsReviewBeforeExam({ stability: 1.5, lastReviewedAt: TODAY, examDate: new Date(2026, 10, 25), now: TODAY }) === true
  );
  check(
    'y no molesta si se llega con el 90%',
    E.needsReviewBeforeExam({ stability: 40, lastReviewedAt: TODAY, examDate: new Date(2026, 10, 5), now: TODAY }) === false
  );
  check('sin fecha de examen no se puede calcular', E.needsReviewBeforeExam({ stability: 5, lastReviewedAt: TODAY, examDate: null, now: TODAY }) === false);
}

console.log('\n8 · Prioridad del día');
{
  const near = E.scoreCandidate({ daysToExam: 2, examWeight: 0.2, measured: true, mastery: 60, errorsOpen: 0, difficulty: 3, dueReview: false, overdueDays: 0, retention: null, status: 'visto', taskDays: null });
  const far = E.scoreCandidate({ daysToExam: 20, examWeight: 0.2, measured: true, mastery: 60, errorsOpen: 0, difficulty: 3, dueReview: false, overdueDays: 0, retention: null, status: 'visto', taskDays: null });
  check('el examen próximo manda', near > far, `${near} > ${far}`);

  const vencido = E.scoreCandidate({ daysToExam: 10, examWeight: 0.2, measured: true, mastery: 60, errorsOpen: 0, difficulty: 3, dueReview: true, overdueDays: 4, retention: 40, status: 'visto', taskDays: null });
  const alDia = E.scoreCandidate({ daysToExam: 10, examWeight: 0.2, measured: true, mastery: 60, errorsOpen: 0, difficulty: 3, dueReview: false, overdueDays: 0, retention: 95, status: 'visto', taskDays: null });
  check('el repaso vencido sube por delante de avanzar', vencido > alDia, `${vencido} > ${alDia}`);

  const sinMedir = E.scoreCandidate({ daysToExam: null, examWeight: 0, measured: false, mastery: 20, errorsOpen: 0, difficulty: 3, dueReview: false, overdueDays: 0, retention: null, status: 'pendiente', taskDays: null });
  const ceroMedido = E.scoreCandidate({ daysToExam: null, examWeight: 0, measured: true, mastery: 20, errorsOpen: 0, difficulty: 3, dueReview: false, overdueDays: 0, retention: null, status: 'pendiente', taskDays: null });
  check('un tema sin medir puntúa menos que uno medido y flojo', sinMedir < ceroMedido, `${sinMedir} < ${ceroMedido}`);

  const enClase = E.scoreCandidate({ daysToExam: null, examWeight: 0, measured: true, mastery: 70, errorsOpen: 0, difficulty: 3, dueReview: false, overdueDays: 0, retention: null, status: 'en_curso', taskDays: null });
  const viejo = E.scoreCandidate({ daysToExam: null, examWeight: 0, measured: true, mastery: 70, errorsOpen: 0, difficulty: 3, dueReview: false, overdueDays: 0, retention: null, status: 'pendiente', taskDays: null });
  check('lo que se está dando en clase gana a lo pendiente', enClase > viejo, `${enClase} > ${viejo}`);

  const conClaseManana = E.scoreCandidate({ daysToExam: null, examWeight: 0, measured: true, mastery: 70, errorsOpen: 0, difficulty: 3, dueReview: false, overdueDays: 0, retention: null, status: 'visto', taskDays: null, classNextDay: true });
  const sinClaseManana = E.scoreCandidate({ daysToExam: null, examWeight: 0, measured: true, mastery: 70, errorsOpen: 0, difficulty: 3, dueReview: false, overdueDays: 0, retention: null, status: 'visto', taskDays: null, classNextDay: false });
  check('la materia que se da mañana sube en la lista', conClaseManana > sinClaseManana, `${conClaseManana} > ${sinClaseManana}`);
  check('pero no aplasta a un examen próximo', conClaseManana < near, `${conClaseManana} < ${near}`);

  const hoyEnClase = E.scoreCandidate({ daysToExam: null, examWeight: 0, measured: true, mastery: 70, errorsOpen: 0, difficulty: 3, dueReview: false, overdueDays: 0, retention: null, status: 'visto', taskDays: null, seenToday: true });
  check('lo dado hoy en clase es la señal más fuerte del avance', hoyEnClase > enClase, `${hoyEnClase} > ${enClase}`);
  const sinExtra = E.scoreCandidate({ daysToExam: null, examWeight: 0, measured: true, mastery: 70, errorsOpen: 0, difficulty: 3, dueReview: false, overdueDays: 0, retention: null, status: 'visto', taskDays: null, seenToday: false });
  check('sin clase hoy no se regala prioridad', sinExtra === sinClaseManana, `${sinExtra} = ${sinClaseManana}`);
  const hoyConExamen = E.scoreCandidate({ daysToExam: 2, examWeight: 0.2, measured: true, mastery: 70, errorsOpen: 0, difficulty: 3, dueReview: false, overdueDays: 0, retention: null, status: 'visto', taskDays: null, seenToday: true });
  check('y se suma al examen próximo sin anularlo', hoyConExamen > near, `${hoyConExamen} > ${near}`);
}

console.log('\n9 · Lectura del avance de clase');
{
  const units = [
    { id: 'a', unitNumber: 4, title: 'Matrices y determinantes', status: 'en_curso' },
    { id: 'b', unitNumber: 5, title: 'Sistemas de ecuaciones lineales', status: 'pendiente' },
    { id: 'c', unitNumber: 6, title: 'Geometría analítica', status: 'pendiente' },
  ];

  const aMedias = C.interpretClassAnswerLocally('hemos empezado la U5, pero solo el primer apartado', units);
  check('una frase real deja la unidad empezada en curso', aMedias.enCurso === 5, JSON.stringify(aMedias));
  check('y no la da por vista', aMedias.vistos.length === 0);
  check('ni se inventa unidades que no ha dicho', aMedias.enCurso !== 6 && aMedias.vistos.length === 0);

  const terminada = C.interpretClassAnswerLocally('ya hemos terminado la unidad 5 entera', units);
  check('si dice que la ha terminado, cuenta como vista', terminada.vistos.includes(5) && terminada.enCurso === null, JSON.stringify(terminada));

  const porTitulo = C.interpretClassAnswerLocally('hoy hemos dado sistemas de ecuaciones lineales', units);
  check('también entiende el título sin el número', porTitulo.enCurso === 5 || porTitulo.vistos.includes(5), JSON.stringify(porTitulo));

  const sinClase = C.interpretClassAnswerLocally('hoy no hubo temario, hicimos un examen', units);
  check('un día sin temario no toca el temario', sinClase.sinTemario && sinClase.vistos.length === 0 && sinClase.enCurso === null);

  const inventada = C.parseClassProgressReply('{"vistos":[5,99],"enCurso":42,"resumen":"ok"}', units);
  check('la IA no puede colar una unidad inexistente', inventada.vistos.length === 1 && inventada.vistos[0] === 5 && inventada.enCurso === null, JSON.stringify(inventada));

  const conFences = C.parseClassProgressReply('```json\n{"vistos":[],"enCurso":6,"resumen":"empezáis la 6"}\n```', units);
  check('lee el JSON aunque venga con vallas', conFences.enCurso === 6, JSON.stringify(conFences));
}

console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLO(S)`} · ${checks} comprobaciones\n`);
process.exit(failures === 0 ? 0 : 1);
