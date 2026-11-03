/**
 * Verifica la puesta a punto: la entrevista que monta el curso contigo.
 *
 *   1. Protocolo y checklist (módulo `src/lib/setup.ts` transpilado y ejecutado
 *      aquí): las etiquetas del coordinador se convierten en acciones reales, lo
 *      imposible se rechaza, las fechas se leen en los dos formatos y el estado
 *      (qué falta, qué toca preguntar) cuadra.
 *   2. Integridad de lo que ha anotado: ninguna unidad de la entrevista puede
 *      llevar un nivel inventado, y todo tiene su origen declarado.
 *   3. Rutas: /puesta-a-punto responde y enseña el progreso y el aviso honesto.
 *   4. Opcional (`-- --live`): un turno real del coordinador al que se le dice
 *      que NO tiene los datos a mano: no puede inventarse temario ni fechas
 *      (consume API). Al terminar limpia la conversación de prueba.
 *
 * Uso:
 *   npm run verify:puesta-a-punto
 *   npm run verify:puesta-a-punto -- --live
 */
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const BASE_URL = process.env.BRAINUP_URL || 'http://localhost:3000';
const LIVE = process.argv.includes('--live');

const problems = [];
const warnings = [];

function ok(label, detail) {
  console.log(`  \u001b[32m✓\u001b[0m ${label}${detail ? ` · ${detail}` : ''}`);
}
function warn(label) {
  warnings.push(label);
  console.log(`  \u001b[33m!\u001b[0m ${label}`);
}
function fail(label) {
  problems.push(label);
  console.log(`  \u001b[31m✗\u001b[0m ${label}`);
}

/**
 * Carga un módulo de `src/lib` transpilado, y con él los módulos puros que
 * importe (`setup.ts` se apoya en `systemKnowledge.ts`, que también es puro).
 *
 * Lo que sigue prohibido es depender de algo de fuera: si un módulo de esta
 * cadena pide Prisma, Next o una librería, se lanza el error. Ese es el sentido
 * de probarlos aislados: si necesitan medio sistema para arrancar, no son
 * módulos puros y esta prueba no valdría para nada.
 */
function loadPureModule(entry) {
  const cache = new Map();

  function load(file) {
    if (cache.has(file)) return cache.get(file);

    const source = fs.readFileSync(file, 'utf8');
    const js = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;

    const module = { exports: {} };
    cache.set(file, module.exports);

    const requireShim = (request) => {
      if (request.startsWith('.')) {
        const base = path.resolve(path.dirname(file), request);
        for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
          if (fs.existsSync(candidate)) return load(candidate);
        }
        throw new Error(`No se encuentra ${request} desde ${path.basename(file)}`);
      }
      throw new Error(
        `${path.basename(file)} debería ser puro (sin dependencias) y pide «${request}»`
      );
    };

    new Function('exports', 'module', 'require', js)(module.exports, module, requireShim);
    cache.set(file, module.exports);
    return module.exports;
  }

  return load(path.join(process.cwd(), 'src', 'lib', `${entry}.ts`));
}

function loadSetupModule() {
  return loadPureModule('setup');
}

/**
 * El respaldo sin IA: la puesta a punto no puede quedarse en un «error».
 *
 * Se le hacen las preguntas que de verdad se hacen (cargar temario, retos, SRS,
 * servidor caído, apuntes, mantenimiento) y se exige que conteste **de la app**,
 * no con una excusa: es la diferencia entre degradar y romperse.
 */
function fallbackTests() {
  console.log('\n2. Coordinador local: contesta aunque no haya IA');

  const knowledge = loadPureModule('systemKnowledge');
  const fallback = loadPureModule('setupFallback');

  const preguntas = [
    ['¿Cómo cargo mi temario en la app?', '/temario'],
    ['¿Qué son los retos semanales y cómo se consiguen XP?', '/retos'],
    ['No entiendo el repaso espaciado, ¿cómo funciona el SRS?', '/repaso'],
    ['Me sale «no se puede acceder a este sitio web», ¿qué hago?', 'npm run sirve'],
    ['¿Dónde declaro mis notas reales?', '/ajustes'],
    ['¿Dónde te cuento un fallo para que se arregle?', '/mantenimiento'],
    ['¿Cómo se descargan los apuntes que escribe el catedrático?', '/apuntes'],
  ];

  let respondidas = 0;

  for (const [pregunta, esperado] of preguntas) {
    const respuesta =
      knowledge.answerSystemQuestion(pregunta) ??
      fallback.buildLocalSetupReply({
        snapshot: { studentName: 'Santiago' },
        checklist: { complete: false, nextQuestion: { prompt: '¿Por dónde vas?' } },
        message: pregunta,
      });

    const bien = typeof respuesta === 'string' && respuesta.includes(esperado);
    if (bien) respondidas += 1;
    else fail(`Sin IA, «${pregunta}» no se contesta con ${esperado}: ${String(respuesta).slice(0, 120)}`);
  }

  if (respondidas === preguntas.length) {
    ok('El coordinador local contesta de la app a todas las preguntas de sistema', `${respondidas}/${preguntas.length}`);
  }

  const colgada = fallback.buildLocalSetupReply({
    snapshot: { studentName: 'Santiago' },
    checklist: { complete: false, nextQuestion: { prompt: '¿Cuántas horas puedes estudiar?' } },
    message: 'Pues no sé, unos 15 horas a la semana',
  });
  if (/\[\[/.test(colgada) || colgada.length < 40) {
    fail('La respuesta local sin pregunta de sistema sale vacía o con etiquetas');
  } else {
    ok('Sin IA y sin pregunta reconocida, sigue la entrevista', colgada.split('\n')[0]);
  }
}

function protocolTests() {
  console.log('\n1. Protocolo del coordinador (módulo aislado)');
  const S = loadSetupModule();

  const reply = `Apuntado. Vamos con Física y Química.

[[asignatura:Física y Química]]
[[origen:profesor]]
[[unidad:Cinemática: MRU y MRUA|1|3]]
[[unidad:Dinámica: leyes de Newton|1]]
[[examen:2026-11-14|Parcial 1|Física y Química|30|9]]`;

  const parsed = S.parseSetupTags(reply);
  const kinds = parsed.actions.map((action) => action.kind);

  if (kinds.join(',') !== 'focus,source,unit,unit,exam') {
    fail(`Las etiquetas no se convierten en las acciones esperadas: ${JSON.stringify(kinds)}`);
  } else {
    ok('Etiquetas → acciones reales', kinds.join(' · '));
  }

  if (/\[\[/.test(parsed.text) || !/Vamos con Física y Química/.test(parsed.text)) {
    fail('El texto visible conserva etiquetas o pierde el mensaje');
  } else {
    ok('El mensaje que ve el alumno va limpio de etiquetas');
  }

  const unit = parsed.actions.find((action) => action.kind === 'unit');
  if (!unit || unit.title !== 'Cinemática: MRU y MRUA' || unit.term !== 1 || unit.difficulty !== 3) {
    fail(`La unidad no se lee bien: ${JSON.stringify(unit)}`);
  } else {
    ok('Unidad con evaluación y dificultad', 'Cinemática: MRU y MRUA · 1ª ev · dif 3');
  }

  const second = parsed.actions.filter((action) => action.kind === 'unit')[1];
  if (!second || second.term !== 1 || second.difficulty !== null) {
    fail(`La unidad sin dificultad no debería inventarse una: ${JSON.stringify(second)}`);
  } else {
    ok('Sin dificultad declarada no se inventa ninguna');
  }

  const exam = parsed.actions.find((action) => action.kind === 'exam');
  if (!exam || exam.date !== '2026-11-14' || exam.weight !== 30 || exam.target !== 9) {
    fail(`El examen no se lee bien: ${JSON.stringify(exam)}`);
  } else {
    ok('Examen con fecha, peso y nota objetivo', '2026-11-14 · 30% · meta 9');
  }

  // Lo imposible se rechaza y se queda fuera (nunca se inventa el dato).
  const bogus = S.parseSetupTags(
    '[[examen:mañana|Parcial]] [[horas:200]] [[unidad:x]] [[ritmo:brutal]] [[meta-pau:20]]'
  );
  if (bogus.actions.length !== 0 || bogus.rejected.length !== 5) {
    fail(
      `Se han aceptado datos imposibles (acciones=${bogus.actions.length}, rechazadas=${bogus.rejected.length})`
    );
  } else {
    ok('Datos imposibles rechazados, ninguno aplicado', '5 etiquetas descartadas');
  }

  // Fechas en los dos formatos que usa la gente.
  const cases = [
    ['14/11/2026', '2026-11-14'],
    ['14-11-26', '2026-11-14'],
    ['2026-03-09', '2026-03-09'],
  ];
  const bad = cases.filter(([input, expected]) => S.parseSetupDate(input) !== expected);
  if (bad.length > 0) {
    fail(`Fechas mal leídas: ${JSON.stringify(bad)}`);
  } else {
    ok('Fechas legibles en formato español y suelto', '14/11/2026 · 14-11-26 · 2026-03-09');
  }
  if (S.parseSetupDate('2026-02-30') !== null || S.parseSetupDate('31/31/2026') !== null) {
    fail('Se ha aceptado una fecha que no existe');
  } else {
    ok('Fechas imposibles rechazadas', '2026-02-30 → null');
  }

  /*
   * HORARIO DE CLASES.
   *
   * Es la pieza que faltaba para que la organización no sea arbitraria: sin el
   * horario, el plan de la tarde no sabe qué se ha explicado hoy ni qué toca
   * mañana. Se prueba que el coordinador pueda dictarlo tal y como lo dice un
   * alumno («los lunes a primera hora», «los martes a tercera», «de 8:15 a 9:10»)
   * y que lo imposible se rechace en vez de aplicarse.
   */
  const schedule = S.parseSetupTags(
    [
      '[[clase:L|1|Matemáticas I|Aula 104]]',
      '[[clase:X|08:15-09:10|Física y Química]]',
      '[[clase:martes|3]]',
      '[[borrar-clase:L|Matemáticas I]]',
      '[[borrar-clase:Historia]]',
    ].join('\n')
  );
  const classes = schedule.actions.filter((action) => action.kind === 'class');
  const classDrops = schedule.actions.filter((action) => action.kind === 'drop-class');
  const firstClass = classes[0];

  if (
    classes.length !== 3 ||
    classDrops.length !== 2 ||
    !firstClass ||
    firstClass.day !== 1 ||
    firstClass.start !== '08:15' ||
    firstClass.end !== '09:10' ||
    firstClass.period !== 1 ||
    firstClass.subject !== 'Matemáticas I' ||
    firstClass.room !== 'Aula 104'
  ) {
    fail(`La clase no se lee como un dato real: ${JSON.stringify(classes)}`);
  } else {
    ok('Una clase se lee con su día, su hora y su aula', 'L 08:15-09:10 · Matemáticas I · Aula 104');
  }

  const thirdClass = classes[2];
  if (
    !thirdClass ||
    thirdClass.day !== 2 ||
    thirdClass.start !== '10:05' ||
    thirdClass.end !== '11:00' ||
    thirdClass.period !== 3 ||
    thirdClass.subject !== null
  ) {
    fail(`«Martes a tercera hora» no se traduce a una hora real: ${JSON.stringify(thirdClass)}`);
  } else {
    ok('«Los martes a tercera hora» se convierte en una hora de verdad', 'M 10:05-11:00');
  }

  if (
    classDrops[0]?.day !== 1 ||
    classDrops[0]?.subject !== 'Matemáticas I' ||
    classDrops[1]?.day !== null ||
    classDrops[1]?.subject !== 'Historia'
  ) {
    fail(`Quitar clases no se lee bien: ${JSON.stringify(classDrops)}`);
  } else {
    ok('Se puede quitar una clase de un día o la materia entera del horario');
  }

  if (/\[\[/.test(schedule.text)) {
    fail('Las etiquetas del horario se quedan a la vista del alumno');
  } else {
    ok('Las etiquetas del horario no se ven');
  }

  const badSchedule = S.parseSetupTags('[[clase:domingo|1|Mates]] [[clase:L|99:99|Mates]] [[clase:L]]');
  if (badSchedule.actions.length !== 0 || badSchedule.rejected.length !== 3) {
    fail(
      `Se ha aceptado un horario imposible (acciones=${badSchedule.actions.length}, rechazadas=${badSchedule.rejected.length})`
    );
  } else {
    ok('Un horario imposible se rechaza y no se aplica', '3 etiquetas descartadas');
  }

  /*
   * EL CURSO ENTERO, NO UNA MUESTRA.
   *
   * Tres etiquetas nuevas que son la diferencia entre un horario real y uno de
   * mentira: las materias que están en el horario pero no se estudian, la
   * confirmación de que el temario está entero y la de que el horario se ha
   * repasado entero. Sin ellas, la puesta a punto se cerraba con la mitad de los
   * datos y el plan salía cojo.
   */
  const extras = S.parseSetupTags(
    [
      '[[solo-horario:Religión]]',
      '[[estudiar:Música]]',
      '[[temario-completo:Matemáticas I]]',
      '[[temario-completo]]',
      '[[horario-completo]]',
    ].join('\n')
  );
  const trackOff = extras.actions.find((action) => action.kind === 'track' && action.tracked === false);
  const trackOn = extras.actions.find((action) => action.kind === 'track' && action.tracked === true);
  const syllabus = extras.actions.filter((action) => action.kind === 'syllabus-complete');
  const timetableDone = extras.actions.find((action) => action.kind === 'timetable-complete');

  if (
    extras.actions.length !== 5 ||
    trackOff?.subject !== 'Religión' ||
    trackOn?.subject !== 'Música' ||
    syllabus.length !== 2 ||
    syllabus[0].subject !== 'Matemáticas I' ||
    syllabus[1].subject !== null ||
    !timetableDone
  ) {
    fail(`Las etiquetas del curso entero no se leen: ${JSON.stringify(extras.actions)}`);
  } else {
    ok(
      'Se marca lo que solo está en el horario, el temario entero y el horario repasado',
      'Religión · Música · Matemáticas I · horario completo'
    );
  }
  if (/\[\[/.test(extras.text)) {
    fail('Las etiquetas nuevas se quedan a la vista del alumno');
  } else {
    ok('Las etiquetas nuevas tampoco se ven');
  }

  /*
   * OBEDECER AL ALUMNO SIN PERDER SUS DATOS.
   *
   * La red que impide que un `[[sustituir]]` mal puesto borre el temario no
   * puede convertir la app en algo que desobedece: si ÉL pide reemplazarlo, se
   * hace. Aquí se comprueba que la petición se reconoce (y que una pregunta o
   * una negación no la disparan) y de qué materia habla.
   */
  const intent = loadPureModule('setupReplaceIntent');
  const names = ['Lengua Castellana y Literatura I', 'Matemáticas I', 'Física y Química'];

  if (
    !intent.hasReplaceIntent('Sustituye el temario de Lengua por este:') ||
    !intent.hasReplaceIntent('Borra todas las unidades de Matemáticas y te dicto las nuevas')
  ) {
    fail('Una orden clara de reemplazo no se reconoce');
  } else {
    ok('Una orden de reemplazo del alumno se reconoce', '«sustituye el temario de Lengua por este»');
  }

  if (
    intent.hasReplaceIntent('¿Qué temario me falta?') ||
    intent.hasReplaceIntent('No cambies el temario de Lengua') ||
    intent.hasReplaceIntent('Hoy he estudiado dos unidades')
  ) {
    fail('Se ha tomado una pregunta o una negación por una orden de reemplazo');
  } else {
    ok('Una pregunta o un «no lo cambies» NO autorizan a borrar nada');
  }

  if (
    intent.matchSubjectInMessage('Sustituye el temario de Lengua por este', names) !==
      'Lengua Castellana y Literatura I' ||
    intent.matchSubjectInMessage('cambia el temario de Física y Química', names) !==
      'Física y Química'
  ) {
    fail('No se sabe de qué materia habla la orden de reemplazo');
  } else {
    ok('Se identifica la materia de la orden, incluso con el nombre corto', 'Lengua · Física y Química');
  }
}

function checklistTests() {
  console.log('\n3. Estado de la puesta a punto (qué falta y qué toca preguntar)');
  const S = loadSetupModule();

  const base = {
    today: '12 de octubre de 2026',
    studentName: 'Santiago',
    modality: '1º de Bachillerato (Ciencias y Tecnología)',
    targetPau: 13.5,
    weeklyHoursCap: 20,
    weeklyHoursDeclared: false,
    studyMode: 'athlete',
    timetable: ['Matemáticas I: L 08:15-09:10, X 08:15-09:10'],
    classCount: 6,
    weeklyClassHours: 5.5,
    // El horario NO está repasado todavía: es lo que debe impedir cerrar la
    // puesta a punto con medio horario.
    timetableComplete: false,
    untracked: ['Religión'],
    setupCompletedAt: null,
    subjects: [
      {
        id: 's1',
        name: 'Matemáticas I',
        units: 8,
        tracked: true,
        syllabusComplete: true,
        classCount: 2,
        upcomingExams: 1,
        nextExam: { title: 'Parcial 1', date: '2026-11-14' },
        // Los exámenes con su título exacto: es lo que el coordinador necesita
        // para poder quitarlos o moverlos por voz.
        exams: [{ title: 'Parcial 1', date: '2026-11-14' }],
        currentUnit: 'Trigonometría',
      },
      {
        id: 's2',
        name: 'Física y Química',
        units: 0,
        tracked: true,
        syllabusComplete: false,
        classCount: 3,
        upcomingExams: 0,
        nextExam: null,
        exams: [],
        currentUnit: null,
      },
      {
        // Está en el horario (ocupa una hora real) pero no se estudia: no debe
        // salir como materia pendiente de temario ni de exámenes.
        id: 's3',
        name: 'Religión',
        units: 0,
        tracked: false,
        syllabusComplete: false,
        classCount: 1,
        upcomingExams: 0,
        nextExam: null,
        exams: [],
        currentUnit: null,
      },
    ],
  };

  const start = S.buildSetupChecklist(base);
  if (start.nextQuestion.about !== 'horas') {
    fail(`Sin horas declaradas debería empezar por las horas (${start.nextQuestion.about})`);
  } else {
    ok('Primero pregunta por las horas reales', start.nextQuestion.prompt);
  }
  if (start.pending.length !== 1 || start.pending[0].name !== 'Física y Química') {
    fail(`Las materias pendientes no cuadran: ${JSON.stringify(start.pending.map((s) => s.name))}`);
  } else {
    ok('Detecta qué materia está a medias', 'Física y Química');
  }
  if (start.untracked.length !== 1 || start.untracked[0].name !== 'Religión') {
    fail(`Las materias que solo están en el horario no se separan: ${JSON.stringify(start.untracked)}`);
  } else {
    ok('Las materias que solo están en el horario no se piden como temario', 'Religión');
  }
  if (start.percent <= 0 || start.percent >= 100) {
    fail(`El progreso debería estar entre 0 y 100 (${start.percent})`);
  } else {
    ok('Progreso calculado sobre datos reales', `${start.doneItems}/${start.totalItems} · ${start.percent}%`);
  }

  // Con las horas puestas, lo siguiente es el HORARIO, aunque ya haya clases
  // apuntadas: lo que falta es repasarlo entero, no apuntar una.
  const withHours = S.buildSetupChecklist({ ...base, weeklyHoursDeclared: true });
  if (withHours.nextQuestion.about !== 'horario') {
    fail(`Con horas puestas debería pedir el horario completo (${JSON.stringify(withHours.nextQuestion)})`);
  } else {
    ok('Después de las horas pide repasar el horario entero', withHours.nextQuestion.prompt);
  }

  // Sin horario, lo que toca es preguntarlo: es lo que permite organizar la
  // tarde según lo que tiene clase al día siguiente (antes se dejaba «para
  // luego» y el plan repartía horas a bulto entre asignaturas).
  const sinHorario = S.buildSetupChecklist({
    ...base,
    weeklyHoursDeclared: true,
    timetable: [],
    classCount: 0,
    untracked: [],
  });
  if (sinHorario.nextQuestion.about !== 'horario' || !/todas/.test(sinHorario.nextQuestion.prompt)) {
    fail(`Con horas pero sin horario debería pedir el horario completo (${sinHorario.nextQuestion.about})`);
  } else {
    ok('Sin una sola clase, pide el horario entero (incluidas las que no estudia)', sinHorario.nextQuestion.prompt);
  }

  const withTimetable = S.buildSetupChecklist({
    ...base,
    weeklyHoursDeclared: true,
    timetableComplete: true,
  });
  if (withTimetable.nextQuestion.about !== 'temario' || withTimetable.nextQuestion.subjectName !== 'Física y Química') {
    fail(`Con el horario cerrado debería pedir el temario que falta (${JSON.stringify(withTimetable.nextQuestion)})`);
  } else {
    ok('Con el horario cerrado pasa al temario que falta', withTimetable.nextQuestion.subjectName);
  }

  // Un temario con unidades pero SIN confirmar no se da por bueno: 3 de 12
  // unidades es exactamente lo que hace que el plan se quede corto.
  const withUnits = S.buildSetupChecklist({
    ...base,
    weeklyHoursDeclared: true,
    timetableComplete: true,
    subjects: base.subjects.map((subject) =>
      subject.id === 's2' ? { ...subject, units: 6 } : subject
    ),
  });
  if (withUnits.nextQuestion.about !== 'temario' || !/entero/.test(withUnits.nextQuestion.prompt)) {
    fail(`Un temario a medias no debería pasar a exámenes (${JSON.stringify(withUnits.nextQuestion)})`);
  } else {
    ok('Un temario con unidades pero sin confirmar no se da por completo', withUnits.nextQuestion.prompt);
  }

  const withWholeSyllabus = S.buildSetupChecklist({
    ...base,
    weeklyHoursDeclared: true,
    timetableComplete: true,
    subjects: base.subjects.map((subject) =>
      subject.id === 's2' ? { ...subject, units: 6, syllabusComplete: true } : subject
    ),
  });
  if (withWholeSyllabus.nextQuestion.about !== 'examenes') {
    fail(`Con el temario confirmado debería pedir fechas de examen (${withWholeSyllabus.nextQuestion.about})`);
  } else {
    ok('Con el temario confirmado entero, pide las fechas que faltan', withWholeSyllabus.nextQuestion.subjectName);
  }

  const completeSubjects = [
    base.subjects[0],
    {
      ...base.subjects[1],
      units: 6,
      syllabusComplete: true,
      upcomingExams: 1,
      nextExam: { title: 'Examen tema 1', date: '2026-10-30' },
      exams: [{ title: 'Examen tema 1', date: '2026-10-30' }],
    },
    base.subjects[2],
  ];

  const all = S.buildSetupChecklist({
    ...base,
    weeklyHoursDeclared: true,
    timetableComplete: true,
    subjects: completeSubjects,
  });
  if (all.nextQuestion.about !== 'cierre' || !all.complete) {
    fail(`Con todo puesto debería ofrecer cerrar (${all.nextQuestion.about}, complete=${all.complete})`);
  } else {
    ok('Con todo montado ofrece cerrar la puesta a punto', '100% de los datos');
  }

  // El horario cuenta para cerrar: una puesta a punto «terminada» sin horario
  // dejaría al plan adivinando qué se da en clase cada día.
  const allSinHorario = S.buildSetupChecklist({
    ...base,
    weeklyHoursDeclared: true,
    timetable: [],
    timetableComplete: false,
    subjects: completeSubjects,
  });
  if (allSinHorario.complete || allSinHorario.nextQuestion.about !== 'horario') {
    fail(
      `Sin horario no se puede dar la puesta a punto por cerrada (complete=${allSinHorario.complete}, toca=${allSinHorario.nextQuestion.about})`
    );
  } else {
    ok('Sin horario la puesta a punto no se cierra', 'el plan no puede ser a ciegas');
  }

  const prompt = S.buildSetupSystemPrompt(base, start);
  const required = [
    'NO INVENTES NADA',
    'UNA pregunta concreta',
    'CORRECCIONES',
    '[[unidad:',
    'Física y Química',
    'AHORA TOCA PREGUNTAR POR',
    '0 unidades',
    'Trigonometría',
    // El prompt tiene que exigir el curso entero, no una muestra.
    '[[solo-horario:',
    '[[temario-completo:',
    '[[horario-completo]]',
    'CUÁNTAS UNIDADES',
    'Solo en el horario (no se les pide temario ni exámenes): Religión',
  ];
  const missing = required.filter((needle) => !prompt.includes(needle));
  if (missing.length > 0) {
    fail(`Al prompt del coordinador le falta: ${missing.join(' · ')}`);
  } else {
    ok('El prompt exige honestidad, correcciones, el estado real y qué preguntar');
  }
  if (/Cinemática|Derivadas|Integrales/.test(prompt)) {
    fail('El prompt mete temario que nadie ha dicho');
  } else {
    ok('El prompt solo lleva datos que existen (unidad en curso real incluida)');
  }
}

async function dataIntegrity() {
  console.log('\n4. Integridad de lo anotado');

  const fromInterview = await prisma.topic.findMany({
    where: { source: 'entrevista' },
    select: { masteryLevel: true, masterySource: true, title: true },
  });

  /**
   * Los únicos orígenes que pueden llevar un nivel (los de una medición real).
   *
   * Esto se mira sobre el estado de hoy, y una unidad nacida en la entrevista
   * puede haber sido **medida después** de verdad: el catedrático la diagnostica
   * en un chat (`diagnostico`), un simulacro la corrige (`simulacro`), el propio
   * alumno se autoevalúa (`autoevaluacion`) o sale de una sesión (`sesion`). Eso no
   * es un nivel inventado: es una medición, y la regla que se comprueba es la que
   * de verdad protege al alumno: **nadie puede tener un nivel sin una medición
   * detrás** (`sin_medir` con nivel distinto de 0, o un origen desconocido).
   */
  const REAL_ORIGINS = ['autoevaluacion', 'diagnostico', 'sesion', 'simulacro'];
  const invented = fromInterview.filter((topic) =>
    topic.masterySource === 'sin_medir'
      ? topic.masteryLevel !== 0
      : !REAL_ORIGINS.includes(topic.masterySource)
  );
  const measuredLater = fromInterview.filter((topic) => REAL_ORIGINS.includes(topic.masterySource));

  if (invented.length > 0) {
    fail(
      `${invented.length} unidad(es) de la entrevista con un nivel que no viene de ninguna medición: ${invented
        .map((topic) => `${topic.title} (${topic.masterySource}=${topic.masteryLevel})`)
        .join(' · ')}`
    );
  } else {
    ok(
      'Unidades de la entrevista: sin nivel inventado',
      `${fromInterview.length} unidad(es) · ${fromInterview.length - measuredLater.length} sin medir y ${measuredLater.length} medidas después de verdad`
    );
  }

  const conversations = await prisma.aiConversation.count({
    where: { agentId: null, title: 'Puesta a punto' },
  });
  if (conversations > 1) {
    warn(`${conversations} conversaciones de puesta a punto (se usa la más reciente)`);
  } else {
    ok('Una sola conversación de puesta a punto', `${conversations}`);
  }

  const user = await prisma.userProfile.findUnique({ where: { id: 'user_default' } });
  if (!user?.weeklyHoursDeclared) {
    warn('Todavía no le has dicho tus horas reales: la puesta a punto las pregunta primero');
  } else {
    ok(`Horas declaradas por ti: ${user.weeklyHoursCap} h/semana`);
  }
}

async function routes() {
  console.log('\n5. Rutas en vivo');

  const user = await prisma.userProfile.findUnique({ where: { id: 'user_default' } });
  const checks = [
    {
      route: '/puesta-a-punto',
      mustInclude: ['Puesta a punto', 'Coordinador', 'del curso'],
      label: '/puesta-a-punto enseña la entrevista y el progreso',
    },
  ];

  if (!user?.setupCompletedAt) {
    checks.push({
      route: '/',
      mustInclude: ['puesta a punto'],
      label: 'Cuartel: aviso de lo que falta por montar',
    });
  } else {
    checks.push({
      route: '/',
      mustInclude: ['Cuartel General'],
      label: 'Cuartel: puesta a punto ya cerrada',
    });
  }

  for (const check of checks) {
    try {
      const response = await fetch(`${BASE_URL}${check.route}`, { redirect: 'follow' });
      if (!response.ok) {
        fail(`${check.route} respondió HTTP ${response.status}`);
        continue;
      }
      const html = (await response.text()).toLowerCase();
      const missing = check.mustInclude.filter((needle) => !html.includes(needle.toLowerCase()));
      if (missing.length > 0) {
        fail(`${check.label} → no encuentro «${missing.join('», «')}»`);
      } else {
        ok(check.label);
      }
    } catch (error) {
      warn(`No pude consultar ${check.route} (${error.message}). ¿Está levantado npm run dev?`);
    }
  }
}

/**
 * CORREGIR LOS EXÁMENES: quitar uno que no existe y mover el que cambia de fecha.
 *
 * Este es un fallo real y con nombre: el alumno le pidió al coordinador que
 * quitara un examen que su profesor no había programado, y la etiqueta se quedó
 * en «no aplicada» dos días seguidos. El examen seguía ahí, metiendo prisa falsa
 * en el plan y en la cuenta atrás, y no había forma de quitarlo ni por voz ni
 * desde el gestor (que solo sabía crear).
 *
 * Se prueba como pasa de verdad: se compila el módulo de la puesta a punto, se
 * apunta un examen de prueba, se mueve de fecha con la etiqueta y se quita con
 * la suya. Al final no queda nada: el examen de prueba se borra en el propio
 * hijo (y también en el `finally` de aquí, por si el hijo muere a medias).
 */
async function examCorrectionTests() {
  console.log('\n6. Exámenes: quitarlos y moverlos (lo que se quedaba sin aplicar)');

  const projectRoot = process.cwd();
  const S = loadSetupModule();
  const title = 'TEMP Examen del guardián';

  /** En este fichero las comprobaciones se llaman `ok`/`fail`: este es su alias. */
  const check = (label, condition, extra) => {
    if (condition) ok(label, typeof extra === 'string' ? extra : undefined);
    else fail(extra === undefined ? label : `${label} · ${extra}`);
  };

  // 6.1 El protocolo (módulo puro): las etiquetas nuevas se leen.
  const drop = S.parseSetupTags(`No hay examen de eso.\n[[borrar-examen:${title}]]`);
  check(
    'la etiqueta de borrar examen se lee como una acción de verdad',
    drop.actions.length === 1 && drop.actions[0].kind === 'drop-exam' && drop.actions[0].title === title,
    JSON.stringify(drop.actions)
  );
  check(
    'y no deja la etiqueta a la vista del alumno',
    !/\[\[/.test(drop.text) && drop.rejected.length === 0
  );

  const move = S.parseSetupTags('[[mover-examen:2026-12-15|' + title + ']]');
  check(
    'la etiqueta de mover examen lee la fecha y el título',
    move.actions.length === 1 &&
      move.actions[0].kind === 'move-exam' &&
      move.actions[0].date === '2026-12-15' &&
      move.actions[0].title === title,
    JSON.stringify(move.actions)
  );
  const moveAlReves = S.parseSetupTags('[[mover-examen:' + title + '|16/12/2026]]');
  check(
    'y la entiende también con el título primero y la fecha en formato español',
    moveAlReves.actions.length === 1 &&
      moveAlReves.actions[0].kind === 'move-exam' &&
      moveAlReves.actions[0].date === '2026-12-16',
    JSON.stringify(moveAlReves.actions)
  );

  // 6.2 De verdad, contra la base: apuntar → mover → quitar.
  const outDirChild = path.join(projectRoot, '.tmp-verify-setup');
  try {
    fs.rmSync(outDirChild, { recursive: true, force: true });
    const { execFileSync } = require('child_process');
    execFileSync(
      process.execPath,
      [
        require.resolve('typescript/bin/tsc'),
        path.join('src', 'lib', 'setupApply.ts'),
        '--outDir',
        '.tmp-verify-setup',
        '--module',
        'commonjs',
        '--target',
        'es2022',
        '--moduleResolution',
        'node',
        // El proyecto usa imports por defecto de módulos de Node (`import path
        // from 'node:path'`), así que hace falta el mismo interop que en su
        // tsconfig; sin él tsc se queja (y aunque emite, queremos un compile
        // limpio: si un día deja de emitir, la prueba tiene que avisar).
        '--esModuleInterop',
        '--skipLibCheck',
      ],
      { cwd: projectRoot, stdio: 'pipe' }
    );

    const childCode = `
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const apply = require(path.join(process.cwd(), '.tmp-verify-setup', 'setupApply.js'));
const setup = require(path.join(process.cwd(), '.tmp-verify-setup', 'setup.js'));
const prisma = new PrismaClient();
const title = ${JSON.stringify(title)};
const BASE = process.env.BRAINUP_URL || 'http://localhost:3000';

(async () => {
  const out = {};
  const subject = await prisma.subject.findFirst({ orderBy: { order: 'asc' } });

  // Apuntar un examen como lo haría el coordinador con la fecha del alumno.
  const created = await apply.applySetupActions([
    { kind: 'focus', subject: subject.name },
    { kind: 'exam', date: '2026-12-01', title, subject: null, weight: 30, target: 9 },
  ]);
  out.apuntado = created.applied.join(' | ');

  // El gestor de exámenes tiene que ofrecer corregirlo (no solo crearlos).
  try {
    const html = await (await fetch(BASE + '/examenes')).text();
    out.gestorConControles = html.includes('Cambiar fecha') && html.includes('Quitar');
  } catch (e) {
    out.gestorConControles = 'sin app: ' + e.message;
  }

  // El profesor cambia la fecha.
  const moved = await apply.applySetupActions(setup.parseSetupTags('[[mover-examen:2026-12-15|' + title + ']]').actions);
  const afterMove = await prisma.exam.findFirst({ where: { title } });
  out.movido = moved.applied.join(' | ');
  out.fecha = afterMove ? afterMove.examDate.toISOString().slice(0, 10) : null;

  // Y el alumno dice que ese examen no existe.
  const dropped = await apply.applySetupActions(setup.parseSetupTags('[[borrar-examen:' + title + ']]').actions);
  out.quitado = dropped.applied.join(' | ');
  out.quedan = await prisma.exam.count({ where: { title } });

  // Quitar algo que no está: ni revienta ni toca lo demás.
  const antes = await prisma.exam.count();
  const fantasma = await apply.applySetupActions(setup.parseSetupTags('[[borrar-examen:Examen que no existe]]').actions);
  out.avisoFantasma = fantasma.problems.join(' | ');
  out.intactos = (await prisma.exam.count()) === antes;

  // HORARIO: se apunta una clase en el primer hueco libre y se quita. El horario
  // real del alumno no se toca: el hueco se elige mirando lo que ya hay puesto.
  const busy = new Set(
    (await prisma.classPeriod.findMany({ select: { dayOfWeek: true, startTime: true } })).map(
      (period) => period.dayOfWeek + '@' + period.startTime
    )
  );
  // El horario real puede estar COMPLETO (seis horas de lunes a viernes): se
  // busca un hueco de verdad en vez de dar por hecho que las seis primeras horas
  // están libres.
  const candidates = [];
  for (let day = 1; day <= 5; day++) {
    for (let hour = 7; hour <= 21; hour++) {
      for (const minute of ['00', '15', '30', '45']) {
        candidates.push(day + '@' + String(hour).padStart(2, '0') + ':' + minute);
      }
    }
  }
  const free = candidates.find((slot) => !busy.has(slot));

  if (!free) {
    out.clase = 'sin hueco libre en el horario para la prueba';
  } else {
    const [day, start] = free.split('@');
    const [startHour, startMinute] = start.split(':').map(Number);
    const endMinutes = startHour * 60 + startMinute + 55;
    const end =
      String(Math.floor(endMinutes / 60)).padStart(2, '0') +
      ':' +
      String(endMinutes % 60).padStart(2, '0');
    const added = await apply.applySetupActions([
      { kind: 'focus', subject: subject.name },
      { kind: 'class', day: Number(day), start, end, period: 1, subject: null, room: 'Aula TEST' },
    ]);
    const row = await prisma.classPeriod.findFirst({
      where: { dayOfWeek: Number(day), startTime: start },
    });
    out.claseApuntada = added.applied.join(' | ');
    out.claseEnBase = row ? row.subjectId === subject.id : false;
    out.claseEnPlan = added.blocks;

    const repeated = await apply.applySetupActions([
      { kind: 'class', day: Number(day), start, end, period: 1, subject: subject.name, room: null },
    ]);
    out.claseDuplicada = repeated.problems.join(' | ');

    if (row) await prisma.classPeriod.delete({ where: { id: row.id } });
    out.claseLimpiada = (await prisma.classPeriod.count({ where: { classroom: 'Aula TEST' } })) === 0;
  }

  // CURSO COMPLETO: una materia que solo está en el horario, el temario
  // confirmado y el horario cerrado. Todo se revierte antes de terminar.
  const religion = await prisma.subject.findFirst({ where: { name: { contains: 'Religión' } } });
  if (religion) {
    const before = await prisma.subject.findUnique({ where: { id: religion.id } });
    out.religionAntes = before.isTracked;
    const marked = await apply.applySetupActions(
      setup.parseSetupTags('[[solo-horario:Religión]]').actions
    );
    const after = await prisma.subject.findUnique({ where: { id: religion.id } });
    out.religionSoloHorario = after.isTracked === false;
    out.religionEnChecklist = marked.checklist.untracked.some((s) => s.name === 'Religión');
    out.religionFueraDePendientes = !marked.checklist.pending.some((s) => s.name === 'Religión');
    out.avisoReligion = marked.applied.join(' | ');
    await prisma.subject.update({
      where: { id: religion.id },
      data: { isTracked: before.isTracked, syllabusComplete: before.syllabusComplete },
    });
  }

  const withTopics = await prisma.subject.findFirst({
    where: { isTracked: true, topics: { some: {} } },
    orderBy: { order: 'asc' },
  });
  if (withTopics) {
    const before = withTopics.syllabusComplete;
    const completed = await apply.applySetupActions([
      { kind: 'focus', subject: withTopics.name },
      { kind: 'syllabus-complete', subject: null },
    ]);
    const after = await prisma.subject.findUnique({ where: { id: withTopics.id } });
    out.temarioCompleto = after.syllabusComplete === true;
    out.avisoTemario = completed.applied.join(' | ');
    await prisma.subject.update({ where: { id: withTopics.id }, data: { syllabusComplete: before } });
  }

  // REEMPLAZO PEDIDO POR EL ALUMNO: con su autorización, una lista más corta
  // SÍ se aplica (es lo que ha pedido). Después se restaura la foto para no
  // dejar el temario de prueba.
  if (withTopics) {
    const snapshot = await prisma.topic.findMany({ where: { subjectId: withTopics.id } });
    const replaced = await apply.applySetupActions(
      [
        { kind: 'focus', subject: withTopics.name },
        { kind: 'replace', subject: null },
        { kind: 'unit', title: 'TEMP Unidad pedida por el alumno', term: null, difficulty: null },
      ],
      { allowReplace: true, allowReplaceSubject: withTopics.name }
    );
    const afterReplace = await prisma.topic.count({ where: { subjectId: withTopics.id } });
    out.reemplazoPedido = afterReplace === 1;
    out.avisoReemplazo = replaced.applied.join(' | ');

    await prisma.$transaction(async (tx) => {
      await tx.topic.deleteMany({ where: { subjectId: withTopics.id } });
      for (const row of snapshot) {
        const { id, createdAt, updatedAt, ...rest } = row;
        await tx.topic.create({ data: rest });
      }
    });
    out.reemplazoRestaurado =
      (await prisma.topic.count({ where: { subjectId: withTopics.id } })) === snapshot.length;
  }

  // GUARDIÁN DEL TEMARIO: sin autorización, un «sustituir» con una lista más
  // corta no puede borrar lo que ya hay. Debe avisar y no tocar nada.
  if (withTopics) {
    const beforeCount = await prisma.topic.count({ where: { subjectId: withTopics.id } });
    const blocked = await apply.applySetupActions([
      { kind: 'focus', subject: withTopics.name },
      { kind: 'replace', subject: null },
      { kind: 'unit', title: 'TEMP Unidad guardián A', term: null, difficulty: null },
      { kind: 'unit', title: 'TEMP Unidad guardián B', term: null, difficulty: null },
    ]);
    const afterCount = await prisma.topic.count({ where: { subjectId: withTopics.id } });
    out.guardiaNoBorra = afterCount === beforeCount;
    out.guardiaAvisa = /No he sustituido el temario/.test(blocked.problems.join(' | '));
    out.guardiaNoCrea = (await prisma.topic.count({ where: { title: { contains: 'TEMP Unidad guardián' } } })) === 0;
  }

  const userBefore = await prisma.userProfile.findUnique({ where: { id: 'user_default' } });
  if (userBefore) {
    const closed = await apply.applySetupActions([{ kind: 'timetable-complete' }]);
    const userAfter = await prisma.userProfile.findUnique({ where: { id: 'user_default' } });
    out.horarioCerrado = userAfter.timetableComplete === true;
    out.avisoHorario = closed.applied.join(' | ');
    await prisma.userProfile.update({
      where: { id: 'user_default' },
      data: { timetableComplete: userBefore.timetableComplete },
    });
  }

  console.log('RESULTADO ' + JSON.stringify(out));
})().catch(async (e) => {
  console.log('RESULTADO ' + JSON.stringify({ error: e.message }));
  process.exit(0);
});
`;

    let child = '';
    try {
      child = execFileSync(process.execPath, ['-e', childCode], {
        cwd: projectRoot,
        encoding: 'utf8',
      });
    } catch (caught) {
      child = `${caught.stdout || ''}${caught.stderr || ''}`;
    }

    const line = (child || '').split('\n').find((l) => l.startsWith('RESULTADO '));
    let result = null;
    try {
      result = line ? JSON.parse(line.slice('RESULTADO '.length)) : null;
    } catch {
      result = null;
    }

    check('la prueba de corrección se ejecuta', Boolean(result) && !result.error, (child || '').slice(0, 300));
    check(
      'el coordinador puede apuntar un examen con la fecha que le dan',
      Boolean(result) && /Examen anotado el 2026-12-01/.test(result.apuntado || ''),
      result ? String(result.apuntado).slice(0, 160) : '—'
    );
    check(
      'y moverlo cuando el profesor cambia la fecha',
      Boolean(result) && result.fecha === '2026-12-15' && /del 2026-12-01 al 2026-12-15/.test(result.movido || ''),
      result ? `${result.fecha} · ${String(result.movido).slice(0, 140)}` : '—'
    );
    check(
      'y quitarlo cuando dice que ese examen no existe (era lo que se quedaba sin aplicar)',
      Boolean(result) && result.quedan === 0 && /Examen quitado/.test(result.quitado || ''),
      result ? String(result.quitado).slice(0, 160) : '—'
    );
    check(
      'quitar uno que no existe avisa y no toca los demás exámenes',
      Boolean(result) && result.intactos === true && /no encuentro ningún examen/i.test(result.avisoFantasma || ''),
      result ? String(result.avisoFantasma).slice(0, 160) : '—'
    );
    check(
      'y el gestor (/examenes) ofrece cambiar la fecha y quitarlos, no solo crearlos',
      Boolean(result) && result.gestorConControles === true,
      result ? String(result.gestorConControles) : '—'
    );
    check(
      'el coordinador puede apuntar una clase con su día y su hora',
      Boolean(result) && result.claseEnBase === true && /Clase apuntada/.test(result.claseApuntada || ''),
      result ? String(result.claseApuntada || result.clase || '—').slice(0, 170) : '—'
    );
    check(
      'y el plan de la semana se recalcula con el horario nuevo',
      Boolean(result) && typeof result.claseEnPlan === 'number',
      result ? `${result.claseEnPlan} bloques` : '—'
    );
    check(
      'apuntar dos veces la misma clase no la duplica',
      Boolean(result) && /ya estaba en el horario/.test(result.claseDuplicada || ''),
      result ? String(result.claseDuplicada || '—').slice(0, 150) : '—'
    );
    check(
      'la clase de prueba no se queda en el horario real',
      Boolean(result) && result.claseLimpiada === true,
      result ? String(result.claseLimpiada) : '—'
    );
    check(
      'una materia del horario puede quedar sin temario ni exámenes (Religión)',
      Boolean(result) &&
        result.religionSoloHorario === true &&
        result.religionEnChecklist === true &&
        result.religionFueraDePendientes === true,
      result ? String(result.avisoReligion || '—').slice(0, 170) : '—'
    );
    check(
      'el temario se puede confirmar entero (lo que impide un plan a medias)',
      Boolean(result) && result.temarioCompleto === true,
      result ? String(result.avisoTemario || '—').slice(0, 170) : '—'
    );
    check(
      'el horario se cierra cuando se repasan los cinco días',
      Boolean(result) && result.horarioCerrado === true,
      result ? String(result.avisoHorario || '—').slice(0, 170) : '—'
    );
    check(
      'si el alumno pide sustituir, una lista más corta SÍ se aplica (y se restaura tras la prueba)',
      Boolean(result) && result.reemplazoPedido === true && result.reemplazoRestaurado === true,
      result ? String(result.avisoReemplazo || '—').slice(0, 170) : '—'
    );
    check(
      'un «sustituir» con una lista más corta NO borra el temario (avisa y no toca nada)',
      Boolean(result) &&
        result.guardiaNoBorra === true &&
        result.guardiaAvisa === true &&
        result.guardiaNoCrea === true,
      result
        ? `conservadas=${result.guardiaNoBorra} · avisa=${result.guardiaAvisa} · sin unidades de prueba=${result.guardiaNoCrea}`
        : '—'
    );
  } catch (error) {
    fail(`No he podido compilar/probar la corrección de exámenes: ${error.message}`);
  } finally {
    // Red de seguridad: si el hijo ha muerto antes de limpiar, se limpia aquí.
    await prisma.exam.deleteMany({ where: { title } }).catch(() => {});
    await prisma.classPeriod.deleteMany({ where: { classroom: 'Aula TEST' } }).catch(() => {});
    fs.rmSync(outDirChild, { recursive: true, force: true });
  }
}

async function liveTurn() {
  console.log('\n6. Turno real del coordinador (--live)');

  const before = {
    topics: await prisma.topic.count(),
    exams: await prisma.exam.count(),
    conversation: await prisma.aiConversation.findFirst({
      where: { agentId: null, title: 'Puesta a punto' },
      select: { id: true },
    }),
  };

  // FOTO DEL TEMARIO, materia por materia.
  //
  // Un turno real puede emitir una etiqueta destructiva ([[sustituir:…]]). El
  // total de unidades no basta para verlo: si una materia pierde 8 y otra gana
  // 8, el total no se mueve y el temario sí se ha roto. Con esta foto se puede
  // detectar y **restaurar** lo que se haya perdido, sin dejar al alumno sin
  // temario por una prueba.
  const topicSnapshot = await prisma.topic.findMany();
  const perSubjectBefore = new Map();
  for (const topic of topicSnapshot) {
    perSubjectBefore.set(topic.subjectId, (perSubjectBefore.get(topic.subjectId) ?? 0) + 1);
  }

  const message =
    'Ahora mismo no tengo el índice a mano ni sé las fechas de mis exámenes. ¿Qué hacemos?';

  try {
    const response = await fetch(`${BASE_URL}/api/puesta-a-punto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.reply?.content) {
      fail(`El coordinador no respondió (HTTP ${response.status}): ${data?.error ?? 'sin detalle'}`);
      return;
    }

    const text = data.reply.content;
    console.log(`  modelo: ${data.model}`);
    console.log(`  respuesta: ${text.slice(0, 200).replace(/\n/g, ' ')}…`);

    if (/\[\[/.test(text)) {
      fail('La respuesta enseña etiquetas internas al alumno');
    } else {
      ok('Sin etiquetas a la vista');
    }

    if (!text.includes('?')) {
      fail('No termina preguntando nada: la entrevista se quedaría parada');
    } else {
      ok('Termina con la siguiente pregunta');
    }

    const invented = (data.applied ?? []).filter((item) => /unidad|examen/i.test(item));
    if (invented.length > 0) {
      fail(`Se ha inventado datos que el alumno no dio: ${invented.join(' · ')}`);
    } else {
      ok('No ha anotado nada que no se le haya dicho');
    }

    const after = {
      topics: await prisma.topic.count(),
      exams: await prisma.exam.count(),
    };

    // ¿Alguna materia ha perdido unidades? Se restaura desde la foto y se da
    // por fallada la prueba: un catedrático/coordinador que borra temario al
    // contestar una duda es exactamente el fallo que no puede volver a pasar.
    const perSubjectAfter = new Map();
    for (const topic of await prisma.topic.findMany({ select: { subjectId: true } })) {
      perSubjectAfter.set(topic.subjectId, (perSubjectAfter.get(topic.subjectId) ?? 0) + 1);
    }
    const lostSubjects = [...perSubjectBefore.entries()].filter(
      ([subjectId, count]) => (perSubjectAfter.get(subjectId) ?? 0) < count
    );

    if (lostSubjects.length > 0) {
      for (const [subjectId] of lostSubjects) {
        const rows = topicSnapshot.filter((topic) => topic.subjectId === subjectId);
        await prisma.$transaction(async (tx) => {
          await tx.topic.deleteMany({ where: { subjectId } });
          for (const row of rows) {
            const { id, createdAt, updatedAt, ...rest } = row;
            await tx.topic.create({ data: rest });
          }
        });
      }
      fail(
        `El coordinador ha borrado unidades sin que se las pidieran (restauradas): ${lostSubjects
          .map(([subjectId, count]) => `${subjectId} ${count}→${perSubjectAfter.get(subjectId) ?? 0}`)
          .join(' · ')}`
      );
    } else if (after.topics !== before.topics || after.exams !== before.exams) {
      fail(
        `La base ha cambiado sin datos: unidades ${before.topics}→${after.topics}, exámenes ${before.exams}→${after.exams}`
      );
    } else {
      ok('La base sigue igual', `${after.topics} unidades · ${after.exams} exámenes`);
    }

    // Limpieza: el turno de prueba no deja conversación (el temario real no se toca).
    if (!before.conversation) {
      await prisma.aiConversation.deleteMany({ where: { agentId: null, title: 'Puesta a punto' } });
      console.log('  (conversación de prueba borrada)');
    }
  } catch (error) {
    fail(`No pude hablar con el coordinador: ${error.message}`);
  }
}

async function main() {
  console.log('VERIFICACIÓN DE LA PUESTA A PUNTO\n==================================');

  protocolTests();
  fallbackTests();
  checklistTests();
  await examCorrectionTests();
  await dataIntegrity();
  await routes();
  if (LIVE) await liveTurn();
  else console.log('\n7. Turno real del coordinador: omitido (usa `npm run verify:puesta-a-punto -- --live`)');

  console.log('\n==================================');
  if (problems.length > 0) {
    console.log(`\u001b[31mFALLOS: ${problems.length}\u001b[0m`);
    for (const problem of problems) console.log(`  · ${problem}`);
    process.exitCode = 1;
    return;
  }
  if (warnings.length > 0) {
    console.log(`\u001b[33mTODO EN VERDE con ${warnings.length} aviso(s)\u001b[0m`);
    for (const warning of warnings) console.log(`  · ${warning}`);
    return;
  }
  console.log('\u001b[32mTODO EN VERDE\u001b[0m');
}

main()
  .catch((error) => {
    // Con la traza: cuando esto falla, saber DÓNDE ahorra media hora.
    console.error('FALLO:', error.stack ?? error.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
