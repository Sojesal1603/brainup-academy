/**
 * Verificación del motor determinista de proactividad (Paso 13).
 *
 * No gasta IA ni toca la base: compila `src/lib/proactivity.ts` con `tsc` y
 * prueba el ranking, la honestidad sin mediciones, las horas de silencio, la
 * zona horaria, los descartes del día y las líneas del catedrático por etapa.
 *
 * Uso: node scripts/verify-proactividad.js   (o npm run verify:proactividad)
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const projectRoot = path.join(__dirname, '..');
const outDir = path.join(projectRoot, '.tmp-verify-proactividad');

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
    path.join('src', 'lib', 'proactivity.ts'),
    '--outDir',
    '.tmp-verify-proactividad',
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

const P = require(path.join(outDir, 'proactivity.js'));

const MADRID = 'Europe/Madrid';
const TOKYO = 'Asia/Tokyo';

function at(iso) {
  return new Date(iso);
}

/* ------------------------------------------------------------------ */
/* Reloj local y horas de silencio                                     */
/* ------------------------------------------------------------------ */

console.log('\nReloj local: el día y la hora del alumno, no los del servidor');

const madridLate = P.localClock(at('2026-11-20T21:30:00Z'), MADRID);
check('22:30 en Madrid', madridLate.minutes === 22 * 60 + 30, madridLate.minutes);
check('el mismo instante ya es día 20', madridLate.dayKey === '2026-11-20', madridLate.dayKey);

const madridMorning = P.localClock(at('2026-11-20T07:30:00Z'), MADRID);
check('08:30 en Madrid no es silencio', !P.isQuietMinutes(madridMorning.minutes));

const madridBoundaryOpen = P.localClock(at('2026-11-20T07:00:00Z'), MADRID);
check('08:00 justo ya está permitido', !P.isQuietHour(at('2026-11-20T07:00:00Z'), MADRID));

const madridBoundaryClose = P.localClock(at('2026-11-20T21:00:00Z'), MADRID);
check('22:00 justo empieza el silencio', P.isQuietMinutes(madridBoundaryClose.minutes));

const madridNight = P.localClock(at('2026-11-20T02:00:00Z'), MADRID);
check('03:00 en Madrid es silencio', P.isQuietMinutes(madridNight.minutes));

const dayBoundary = P.localClock(at('2026-11-20T23:30:00Z'), MADRID);
check('23:30 UTC en Madrid ya es 21', dayBoundary.dayKey === '2026-11-21', dayBoundary.dayKey);

const tokyoClock = P.localClock(at('2026-11-20T23:00:00Z'), TOKYO);
check('23:00 UTC en Tokio son las 08:00 del día siguiente', tokyoClock.dayKey === '2026-11-21' && tokyoClock.minutes === 8 * 60, JSON.stringify(tokyoClock));
check('Tokio a las 08:00 no está en silencio', !P.isQuietHour(at('2026-11-20T23:00:00Z'), TOKYO));

const invalidZone = P.localClock(at('2026-11-20T12:00:00Z'), 'Zona/Que-No-Existe');
check('zona inválida cae en Europe/Madrid', invalidZone.minutes === 13 * 60, invalidZone.minutes);

check(
  'un examen a las 23:30 de hoy cuenta como mañana en Madrid',
  P.localDaysBetween(at('2026-11-20T10:00:00Z'), at('2026-11-20T23:30:00Z'), MADRID) === 1
);
check(
  'el mismo día local da cero días',
  P.localDaysBetween(at('2026-11-20T10:00:00Z'), at('2026-11-20T18:00:00Z'), MADRID) === 0
);

/* ------------------------------------------------------------------ */
/* Hora del aviso                                                      */
/* ------------------------------------------------------------------ */

console.log('\nHora del aviso: no se guarda lo que luego no se enviaría');

check('17:00 se acepta', P.validateReminderTime('17:00').ok === true);
check('08:00 se acepta', P.validateReminderTime('08:00').ok === true);
check('21:59 se acepta', P.validateReminderTime('21:59').ok === true);
check('22:00 se rechaza', P.validateReminderTime('22:00').ok === false);
check('03:00 se rechaza', P.validateReminderTime('03:00').ok === false);
check('07:59 se rechaza', P.validateReminderTime('07:59').ok === false);
check('formato sin cero se rechaza', P.validateReminderTime('7:00').ok === false);
check('24:00 se rechaza', P.validateReminderTime('24:00').ok === false);
check('texto vacío se rechaza', P.validateReminderTime('').ok === false);

/* ------------------------------------------------------------------ */
/* Ranking                                                             */
/* ------------------------------------------------------------------ */

console.log('\nRanking: examen → repaso → errores → racha → bloque del plan');

const planBase = {
  sessions: [
    {
      id: 'b1',
      topicTitle: 'Derivadas',
      subjectName: 'Matemáticas',
      status: 'pendiente',
      durationMinutes: 40,
      reason: 'Examen cerca y unidad en curso',
    },
  ],
  dueReviews: 2,
  errorsOpen: 3,
  headline: 'Hoy toca Matemáticas',
  studiedMinutes: 0,
};

const examSoon = { title: 'Examen de Matemáticas', days: 3, weight: 0.2, subjectName: 'Matemáticas' };

const withExam = P.buildProactiveProposal({
  now: at('2026-11-20T11:00:00Z'),
  timezone: MADRID,
  plan: planBase,
  nextExam: examSoon,
  measuredUnits: 4,
  streak: { current: 5, studiedToday: false },
});
check('el examen próximo manda', withExam.primary.kind === 'examen', withExam.primary.kind);
check('la tarjeta cita los días', withExam.primary.title.includes('3 días'), withExam.primary.title);
check('el examen enlaza a /examenes', withExam.primary.action.href === '/examenes');
check('hay como mucho 2 secundarias', withExam.secondary.length === 2, withExam.secondary.length);
check(
  'la secundaria no repite el tipo primario',
  withExam.secondary.every((item) => item.kind !== 'examen')
);
check(
  'cada propuesta lleva evidencia',
  [withExam.primary, ...withExam.secondary].every((item) => item.evidence.length > 0)
);

const dueOnly = P.buildProactiveProposal({
  now: at('2026-11-20T11:00:00Z'),
  timezone: MADRID,
  plan: planBase,
  nextExam: null,
  measuredUnits: 4,
});
check('sin examen manda el repaso vencido', dueOnly.primary.kind === 'repaso', dueOnly.primary.kind);
check('el repaso enlaza a /repaso', dueOnly.primary.action.href === '/repaso');
check('cuenta las unidades vencidas', dueOnly.primary.title.includes('2'), dueOnly.primary.title);

const errorsOnly = P.buildProactiveProposal({
  now: at('2026-11-20T11:00:00Z'),
  timezone: MADRID,
  plan: { ...planBase, dueReviews: 0 },
  measuredUnits: 4,
});
check('sin repaso mandan los errores', errorsOnly.primary.kind === 'errores', errorsOnly.primary.kind);
check('los errores enlazan a /errores', errorsOnly.primary.action.href === '/errores');

const streakEvening = P.buildProactiveProposal({
  now: at('2026-11-20T18:30:00Z'), // 19:30 Madrid
  timezone: MADRID,
  plan: { ...planBase, dueReviews: 0, errorsOpen: 0 },
  measuredUnits: 4,
  streak: { current: 5, studiedToday: false },
});
check('por la tarde la racha gana al bloque', streakEvening.primary.kind === 'racha', streakEvening.primary.kind);
check('la racha lleva al bloque actual', streakEvening.primary.action.href === '/#ahora');

const streakMorning = P.buildProactiveProposal({
  now: at('2026-11-20T09:00:00Z'), // 10:00 Madrid
  timezone: MADRID,
  plan: { ...planBase, dueReviews: 0, errorsOpen: 0 },
  measuredUnits: 4,
  streak: { current: 5, studiedToday: false },
});
check('por la mañana no se habla de racha en riesgo', streakMorning.primary.kind === 'empezar', streakMorning.primary.kind);

const streakDone = P.buildProactiveProposal({
  now: at('2026-11-20T18:30:00Z'),
  timezone: MADRID,
  plan: { ...planBase, dueReviews: 0, errorsOpen: 0, studiedMinutes: 50 },
  measuredUnits: 4,
  streak: { current: 5, studiedToday: true },
});
check('si ya ha estudiado no se insiste con la racha', streakDone.primary.kind === 'empezar', streakDone.primary.kind);

/* ------------------------------------------------------------------ */
/* Honestidad: sin mediciones no se inventa un riesgo                  */
/* ------------------------------------------------------------------ */

console.log('\nHonestidad: sin mediciones se propone medir o se calla');

const noData = P.buildProactiveProposal({
  now: at('2026-11-20T11:00:00Z'),
  timezone: MADRID,
  plan: { sessions: [], dueReviews: 0, errorsOpen: 0 },
  measuredUnits: 0,
});
check('sin datos propone medir', noData.primary.kind === 'medir', noData.primary.kind);
check('no usa la palabra riesgo', !/riesgo/i.test(noData.primary.title + ' ' + noData.primary.detail));
check('la medición lleva a /temario', noData.primary.action.href === '/temario');

const measuredEmpty = P.buildProactiveProposal({
  now: at('2026-11-20T11:00:00Z'),
  timezone: MADRID,
  plan: { sessions: [], dueReviews: 0, errorsOpen: 0 },
  measuredUnits: 12,
});
check('con mediciones y sin señales, silencio', measuredEmpty.primary === null, measuredEmpty.primary);
check('el silencio se explica', typeof measuredEmpty.reason === 'string' && measuredEmpty.reason.length > 0);

/* ------------------------------------------------------------------ */
/* Descartes y fatiga                                                  */
/* ------------------------------------------------------------------ */

console.log('\nDescartes: una propuesta descartada no vuelve ese día');

const dismissed = P.buildProactiveProposal({
  now: at('2026-11-20T11:00:00Z'),
  timezone: MADRID,
  plan: planBase,
  measuredUnits: 4,
  dismissedKinds: ['repaso'],
});
check('descartar repaso deja pasar errores', dismissed.primary.kind === 'errores', dismissed.primary.kind);
check('la clave del descarte incluye el día', P.dismissalStorageKey('2026-11-20') === 'brainup.proactive.2026-11-20');

const allDismissed = P.buildProactiveProposal({
  now: at('2026-11-20T11:00:00Z'),
  timezone: MADRID,
  plan: planBase,
  measuredUnits: 4,
  dismissedKinds: ['repaso', 'errores', 'empezar'],
});
check('todo descartado no deja propuesta', allDismissed.primary === null);
check('se explica que el plan sigue disponible', /plan sigue disponible/i.test(allDismissed.reason));

/* ------------------------------------------------------------------ */
/* Horas de silencio en la decisión                                    */
/* ------------------------------------------------------------------ */

console.log('\nSilencio: la tarjeta puede verse, el aviso no debe sonar');

const night = P.buildProactiveProposal({
  now: at('2026-11-20T22:30:00Z'), // 23:30 Madrid
  timezone: MADRID,
  plan: planBase,
  measuredUnits: 4,
});
check('de madrugada la decisión marca silencio', night.quiet === true);
check('la propuesta sigue existiendo para la pantalla', night.primary !== null);

const noon = P.buildProactiveProposal({
  now: at('2026-11-20T11:00:00Z'),
  timezone: MADRID,
  plan: planBase,
  measuredUnits: 4,
});
check('a mediodía no hay silencio', noon.quiet === false);

/* ------------------------------------------------------------------ */
/* El motor no muta la foto del plan                                   */
/* ------------------------------------------------------------------ */

const before = JSON.stringify(planBase);
P.buildProactiveProposal({
  now: at('2026-11-20T11:00:00Z'),
  timezone: MADRID,
  plan: planBase,
  nextExam: examSoon,
  measuredUnits: 4,
});
check('el plan recibido no se modifica', JSON.stringify(planBase) === before);

/* ------------------------------------------------------------------ */
/* Línea del catedrático por etapa                                     */
/* ------------------------------------------------------------------ */

console.log('\nCatedrático: una línea por reglas, adaptada a la etapa');

const examLine = {
  examTitle: 'Examen de Física',
  examDays: 2,
  unmeasuredCount: 3,
  pendingErrors: 2,
};
const lineEso = P.buildTutorProactiveLine({ ...examLine, stage: 'ESO' });
const lineBach = P.buildTutorProactiveLine({ ...examLine, stage: 'BACHILLERATO' });
const lineUni = P.buildTutorProactiveLine({ ...examLine, stage: 'UNIVERSIDAD' });

check('ESO nombra el examen', /Examen de Física/.test(lineEso), lineEso);
check('Bachillerato nombra el examen', /Examen de Física/.test(lineBach), lineBach);
check('Universidad nombra el examen', /Examen de Física/.test(lineUni), lineUni);
check('las tres etapas no dicen lo mismo', new Set([lineEso, lineBach, lineUni]).size === 3);
check('Bachillerato habla de nota', /nota/.test(lineBach), lineBach);
check('ESO no habla de nota de corte', !/nota de corte/i.test(lineEso), lineEso);

const weakLine = P.buildTutorProactiveLine({ stage: 'ESO', weakTopicLabel: 'Fracciones' });
check('sin examen se apoya en la unidad floja', /Fracciones/.test(weakLine), weakLine);

const emptyLine = P.buildTutorProactiveLine({ stage: 'UNIVERSIDAD' });
check('sin señales no inventa línea', emptyLine === null, emptyLine);

/* ------------------------------------------------------------------ */
/* Integración en el Cuartel                                           */
/* ------------------------------------------------------------------ */

console.log('\nIntegración: la tarjeta cita el plan y no decide por su cuenta');

const widgetsSource = fs.readFileSync(
  path.join(projectRoot, 'src', 'components', 'cuartel', 'DashboardWidgets.tsx'),
  'utf8'
);
const cardSource = fs.readFileSync(
  path.join(projectRoot, 'src', 'components', 'cuartel', 'ProactiveCard.tsx'),
  'utf8'
);
const hoySource = fs.readFileSync(
  path.join(projectRoot, 'src', 'components', 'cuartel', 'HoyTocaEsto.tsx'),
  'utf8'
);

check('el Cuartel usa el motor', /buildProactiveProposal/.test(widgetsSource));
check(
  'la tarjeta va antes de «Hoy toca esto»',
  widgetsSource.indexOf('<ProactiveCard') > -1 &&
    widgetsSource.indexOf('<ProactiveCard') < widgetsSource.indexOf('<HoyTocaEsto')
);
check('la tarjeta no consulta Prisma ni IA', !/from '@\/lib\/(db|prisma|aiEngine)'/.test(cardSource));
check('el descarte usa la clave del día', /dismissalStorageKey\(decision\.dayKey\)/.test(cardSource));
check('«Hoy toca esto» tiene el ancla del bloque actual', /id="ahora"/.test(hoySource));

const pushSource = fs.readFileSync(path.join(projectRoot, 'src', 'lib', 'push.ts'), 'utf8');
const actionsSource = fs.readFileSync(path.join(projectRoot, 'src', 'lib', 'actions.ts'), 'utf8');
check(
  'el envío descarta la franja de silencio',
  /isQuietMinutes\(clock\.minutes\)/.test(pushSource)
);
check(
  'el guardado del aviso usa la misma validación',
  /validateReminderTime/.test(actionsSource)
);
check(
  'el push no decide la hora por su cuenta',
  !/QUIET_START_MINUTES\s*=/.test(pushSource)
);

/* ------------------------------------------------------------------ */
/* Resultado                                                           */
/* ------------------------------------------------------------------ */

console.log('');
if (failures > 0) {
  console.log(`${failures} FALLO(S)`);
  process.exit(1);
}
console.log('TODO EN VERDE');
