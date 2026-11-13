/**
 * Verificación del taller de mantenimiento.
 *
 * Todo esto es **offline, determinista y gratis**: se transpila
 * `src/lib/maintenance.ts` (que es puro: sin Prisma y sin red) y se le dan datos
 * de mentira para comprobar las tres cosas que pueden hundir un taller así:
 *
 *   1. **Que no grite en falso.** Un expediente sano tiene que dar CERO
 *      hallazgos: si el taller avisa de lo que está bien, se deja de mirar.
 *      Después, una prueba por comprobación (`titulos_sucios`, `unidades_duplicadas`,
 *      `numeracion_duplicada`, `numeracion_rota`, `temario_vacio`, `nivel_sin_medir`,
 *      `srs_fuera_de_rango`, `repaso_en_el_futuro`, `estado_incoherente`,
 *      `estado_desconocido`, `examenes_caducados`, `racha_negativa`,
 *      `habitos_duplicados`, `retos_caducados`, `ia_sin_claves`, `ia_saturada`,
 *      `incidencias_abiertas`) que salta con el caso que rompe esa regla y con su
 *      gravedad real, y que no arrastra hallazgos de otras reglas.
 *
 *   2. **Que lo que borra esté vacío.** Un plan de arreglos nunca puede llevarse
 *      por delante filas con datos: se comprueba que ningún `delete_topic` apunta
 *      a una unidad con apuntes, errores, bloques, sesiones o repasos, que los
 *      registros de hábito borrados son los sobrantes (nunca el primero), y que
 *      lo que no es `safe` es solo cerrar exámenes pasados. Los planes se miran
 *      además en forma: `count` = operaciones, descripción que dice qué cambia,
 *      id estable y toda comprobación arreglable con su plan.
 *
 *   3. **Los títulos y la semana.** `normalizeTitle`/`tidyTitle` (acentos,
 *      espacios, puntos finales) y que la comparación de retos se haga por la
 *      clave de la semana en curso, no por parecerse.
 *
 * Lo que NO entra aquí: el taller en vivo contra la base y la app (aplicar
 * arreglos de verdad, la auditoría con IA, `/mantenimiento`) — eso necesita el
 * servidor levantado y lo comprueba el coordinador.
 *
 * Uso:
 *   npm run verify:mantenimiento
 */

const fs = require('fs');
const { getTestUserId } = require('./testUser.js');
const path = require('path');
const ts = require('typescript');

const LIVE = process.argv.includes('--live');
const projectRoot = path.join(__dirname, '..');

let failures = 0;
const failed = [];

function section(title) {
  console.log(`\n${title}`);
}

function check(label, condition, detail) {
  if (condition) {
    console.log(`  \u001b[32m✓\u001b[0m ${label}${detail ? ` · ${detail}` : ''}`);
  } else {
    failures += 1;
    failed.push(label);
    console.log(`  \u001b[31m✗\u001b[0m ${label}${detail ? ` · ${detail}` : ''}`);
  }
}

/**
 * Carga `src/lib/maintenance.ts` transpilado a JS.
 *
 * Tiene que seguir siendo **puro de verdad**: nada de Prisma, ni red, ni disco.
 * Los `import type` sí se permiten (el compilador los borra: no llegan a existir
 * en tiempo de ejecución), así que la comprobación es contra los imports de
 * valor, que son los que arrastrarían dependencias.
 */
function loadMaintenanceModule() {
  const file = path.join(projectRoot, 'src', 'lib', 'maintenance.ts');
  const source = fs.readFileSync(file, 'utf8');
  const valueImports = [...source.matchAll(/^\s*import\s+(?!type\s)/gm)];
  if (valueImports.length > 0) {
    throw new Error(
      'maintenance.ts debería ser puro: solo puede importar tipos (import type), no código'
    );
  }
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  new Function('exports', 'module', js)(module.exports, module);
  return module.exports;
}

/* ------------------------------------------------------------------ */
/* Datos de mentira                                                    */
/* ------------------------------------------------------------------ */

// Fechas sin zona horaria explícita: el motor compara por día local
// (`startOfDay`), así que las pruebas no dependen del huso de la máquina.
const TODAY = '2026-10-13T12:00:00';
const WEEK_KEY = '2026-W42';
const PAST_EXAM = '2026-10-01T12:00:00';
const FUTURE_EXAM = '2026-11-14T12:00:00';
const FUTURE_REVIEW = '2026-11-01T09:00:00';
const PAST_REVIEW = '2026-10-06T09:00:00';

const EMPTY_ATTACHED = { notes: 0, errors: 0, blocks: 0, sessions: 0, reviews: 0 };

/** Un apunte con lo que el redactor deja cuando se pone nervioso: valla y HTML. */
const DIRTY_NOTE = [
  '## Fórmulas',
  '',
  '```',
  'a/b = c',
  '```',
  '',
  '<details><summary>¿Qué pide la continuidad?</summary>Que coincidan.</details>',
].join('\n');

/** Un apunte tal y como debe quedar: Markdown y LaTeX, sin una etiqueta. */
const CLEAN_NOTE = [
  '# Límites y continuidad',
  '',
  '## Lo que tienes que saber',
  '',
  '- Una idea con $x^2$ y una regla de tres.',
  '',
  '**Respuesta:** Que el límite y el valor coincidan.',
].join('\n');

function topic(over) {
  return Object.assign(
    {
      id: 'tx',
      subjectId: 's-mate',
      subjectName: 'Matemáticas I',
      title: 'Unidad',
      unitNumber: 1,
      status: 'pendiente',
      lastReviewedAt: null,
      srsIntervalDays: 3,
      srsEaseFactor: 2.5,
      // La app guarda 0 para decir «sin medir» (actions.ts / setupApply.ts).
      masteryLevel: 0,
      masterySource: 'sin_medir',
      attached: Object.assign({}, EMPTY_ATTACHED),
    },
    over || {}
  );
}

/** Un expediente sano: temario numerado 1..N, sin duplicados ni valores raros. */
function healthy() {
  return {
    today: TODAY,
    weekKey: WEEK_KEY,
    topics: [
      topic({
        id: 'm1',
        title: 'Límites y continuidad',
        unitNumber: 1,
        status: 'visto',
        lastReviewedAt: PAST_REVIEW,
        srsIntervalDays: 7,
        srsEaseFactor: 2.4,
        masteryLevel: 42,
        masterySource: 'diagnostico',
      }),
      topic({ id: 'm2', title: 'Derivadas', unitNumber: 2, status: 'en_curso' }),
      topic({
        id: 'f1',
        subjectId: 's-fis',
        subjectName: 'Física',
        title: 'Cinemática',
        unitNumber: 1,
        status: 'pendiente',
      }),
    ],
    subjects: [
      { id: 's-mate', name: 'Matemáticas I', order: 1, units: 2, classPeriods: 4 },
      { id: 's-fis', name: 'Física', order: 2, units: 1, classPeriods: 3 },
    ],
    exams: [
      { id: 'e1', title: 'Parcial 1', subjectName: 'Matemáticas I', examDate: FUTURE_EXAM, isCompleted: false },
    ],
    habits: [{ id: 'h1', title: 'Leer 20 min', streak: 5, logsToday: 1, extraLogIds: [] }],
    challenges: [
      { id: 'c1', weekKey: WEEK_KEY, weekStart: '2026-10-12T00:00:00', status: 'active', title: 'Estudia 9 h' },
    ],
    issues: [{ id: 'i1', title: 'Ya revisado por el alumno', status: 'resuelto' }],
    ai: { gemini: true, groq: true, availableModels: 3, coolingDown: 0 },
  };
}

/**
 * El estropicio de la pérdida: la materia tenía temario antes (por eso hay copia)
 * y ahora está vacía. Vivió aquí el 16 de octubre de 2026, cuando la semilla se
 * llevó por delante un temario entero de 111 unidades: la copia es lo que permitió
 * reponerlo, así que el caso se prueba para que no vuelva a pasar en silencio.
 */
function sinTemarioConCopia(input) {
  input.topics = input.topics.filter((row) => row.subjectId !== 's-fis');
  const fisica = input.subjects.find((subject) => subject.id === 's-fis');
  fisica.units = 0;
  fisica.backupUnits = 1;
  fisica.backupFrom = 'temario-2026-10-16T08-00-00-auto.json';
}

/** Copia del expediente sano con un estropicio aplicado. */
function variant(mutate) {
  const input = JSON.parse(JSON.stringify(healthy()));
  mutate(input);
  return input;
}

function ids(findings) {
  return findings.map((finding) => finding.id);
}

/** Busca el hallazgo de una regla concreta. */
function findingOf(findings, id) {
  return findings.find((finding) => finding.id === id) || null;
}

/** El estropicio debe producir ese hallazgo, con esa gravedad y sin arrastrar otros. */
function expectOnly(M, label, input, id, severity, assertDetail) {
  const findings = M.runMaintenanceChecks(input);
  const target = findingOf(findings, id);

  check(`${label} → hallazgo «${id}»`, target !== null, target ? '' : `encontrado: ${ids(findings).join(', ') || 'nada'}`);
  check(`${label} → gravedad ${severity}`, target !== null && target.severity === severity, target ? target.severity : '—');
  const others = ids(findings).filter((otherId) => otherId !== id);
  check(`${label} → sin hallazgos de rebote`, others.length === 0, others.join(', ') || 'limpio');
  if (target) {
    check(`${label} → cuenta y ejemplos con sentido`, target.count > 0 && target.samples.length > 0, `count=${target.count} · ${target.samples.length} ejemplo(s)`);
  }
  if (assertDetail && target) assertDetail(target, findings);
}

/** El caso sano de esa regla no puede sacar ningún hallazgo. */
function expectSilence(M, label, input) {
  const findings = M.runMaintenanceChecks(input);
  check(`${label} → el motor no dice nada`, findings.length === 0, ids(findings).join(', ') || 'limpio');
}

/* ------------------------------------------------------------------ */
/* 1. Las comprobaciones                                               */
/* ------------------------------------------------------------------ */

function checksSection(M) {
  section('1. Que el motor no grite en falso (expediente sano)');
  const clean = M.runMaintenanceChecks(healthy());
  check('Un expediente sano no tiene ningún hallazgo', clean.length === 0, ids(clean).join(', ') || 'limpio');
  check('Y por tanto tampoco hay nada que arreglar', M.buildMaintenanceFixes(healthy()).length === 0);

  section('2. Una prueba por regla: salta cuando toca y con su gravedad');
  const sinkIds = ids(M.runMaintenanceChecks(kitchenSink()));
  check(
    'Ninguna regla se repite en la misma pasada (ni con todo roto)',
    new Set(sinkIds).size === sinkIds.length,
    `${sinkIds.length} hallazgo(s)`
  );

  // Temario: títulos
  expectOnly(
    M,
    'Título con espacios y punto final',
    variant((input) => {
      input.topics[1].title = '  Derivadas .';
    }),
    'titulos_sucios',
    'info'
  );

  // Temario: unidades repetidas (vacía -> info; con datos -> aviso)
  expectOnly(
    M,
    'Unidad repetida y vacía',
    variant((input) => {
      input.topics.push(topic({ id: 'm3', title: 'Derivadas', unitNumber: 3 }));
    }),
    'unidades_duplicadas',
    'info',
    (target) => check('Y solo cuenta la copia de más', target.count === 1, `count=${target.count}`)
  );

  expectOnly(
    M,
    'Unidad repetida con datos colgando',
    variant((input) => {
      // La copia original también tiene datos dentro: la que sobraría lleva cosas
      // colgando, y ese es justo el caso que no se puede borrar solo.
      input.topics[1].attached = Object.assign({}, EMPTY_ATTACHED, { notes: 1 });
      input.topics.push(
        topic({
          id: 'm3',
          title: 'Derivadas',
          unitNumber: 3,
          attached: Object.assign({}, EMPTY_ATTACHED, { notes: 2 }),
        })
      );
    }),
    'unidades_duplicadas',
    'aviso'
  );

  // Temario: numeración
  expectOnly(
    M,
    'Dos unidades con el mismo número',
    variant((input) => {
      input.topics.push(topic({ id: 'm3', title: 'Trigonometría', unitNumber: 2 }));
    }),
    'numeracion_duplicada',
    'aviso',
    (target) => check('Cuenta las dos que comparten número', target.count === 2, `count=${target.count}`)
  );

  expectOnly(
    M,
    'Numeración con un hueco (1, 4)',
    variant((input) => {
      input.topics[1].unitNumber = 4;
    }),
    'numeracion_rota',
    'info'
  );

  expectOnly(
    M,
    'Unidad sin número en un temario ya numerado',
    variant((input) => {
      input.topics[1].unitNumber = null;
    }),
    'numeracion_rota',
    'info',
    (target) => check('Cuenta la numerada y la que no lo está', target.count === 2, `count=${target.count}`)
  );

  // Temario: asignatura sin nada
  expectOnly(
    M,
    'Asignatura sin temario',
    variant((input) => {
      input.subjects.push({ id: 's-bio', name: 'Biología', order: 3, units: 0, classPeriods: 0 });
    }),
    'temario_vacio',
    'info',
    (target) => check('Y dice que eso no se arregla solo', target.fixable === false)
  );

  // Temario: una materia que se ha quedado vacía pero hay copia de la que tirar.
  // Es la diferencia entre «aún no lo he cargado» (normal) y «lo tenía y se ha
  // perdido» (una pérdida que el sistema repone solo): `sinTemarioConCopia` vive
  // arriba, con los demás datos de mentira, porque lo usan dos secciones.
  expectOnly(
    M,
    'Materia sin temario pero con copia disponible',
    variant(sinTemarioConCopia),
    'temario_perdido',
    'aviso',
    (target) =>
      check(
        'Y dice que eso sí se puede reponer',
        target.fixable === true && /Reponer/.test(String(target.fixLabel)),
        String(target.fixLabel)
      )
  );

  {
    // Sin copia no hay pérdida que reponer: sigue siendo una materia pendiente de
    // cargar, y decir lo contrario sería inventarse una copia que no existe.
    const sinCopia = variant((input) => {
      input.topics = input.topics.filter((row) => row.subjectId !== 's-fis');
      input.subjects.find((subject) => subject.id === 's-fis').units = 0;
    });
    const hallazgos = M.runMaintenanceChecks(sinCopia);
    check(
      'Sin copia no se habla de pérdida: solo de temario pendiente de cargar',
      findingOf(hallazgos, 'temario_perdido') === null && findingOf(hallazgos, 'temario_vacio') !== null,
      ids(hallazgos).join(', ') || 'limpio'
    );
    check(
      'Y no se propone ningún arreglo que lo prometa',
      M.buildMaintenanceFixes(sinCopia).every((fix) => fix.id !== 'temario_perdido')
    );
  }

  {
    // Una materia con su temario no es una pérdida aunque exista una copia suya:
    // lo que hay manda sobre lo que hubo.
    const conTemario = variant((input) => {
      const mate = input.subjects.find((subject) => subject.id === 's-mate');
      mate.backupUnits = 14;
      mate.backupFrom = 'temario-2026-10-16T08-00-00-auto.json';
    });
    const hallazgos = M.runMaintenanceChecks(conTemario);
    check(
      'Una materia con temario y con copia no es una pérdida (y no se propone reponerla)',
      findingOf(hallazgos, 'temario_perdido') === null &&
        M.buildMaintenanceFixes(conTemario).every((fix) => fix.id !== 'temario_perdido'),
      ids(hallazgos).join(', ') || 'limpio'
    );
  }

  // Honestidad: nivel inventado
  expectOnly(
    M,
    'Nivel puesto en una unidad «sin medir»',
    variant((input) => {
      input.topics[1].masteryLevel = 88;
    }),
    'nivel_sin_medir',
    'aviso'
  );

  // Las dos formas honestas de decir «no lo sé»: 0 (lo que escribe la app al crear
  // o limpiar una unidad) y 20 (el valor por defecto del esquema). Ninguna de las
  // dos puede dar un aviso: si las marcara, el taller avisaría en falso del
  // expediente entero cada vez que se carga un temario.
  for (const level of [0, 20]) {
    check(
      `Un nivel de ${level} con origen «sin medir» es honesto, no un fallo`,
      M.runMaintenanceChecks(
        variant((input) => {
          input.topics[1].masteryLevel = level;
        })
      ).every((finding) => finding.id !== 'nivel_sin_medir')
    );
  }

  // SRS
  expectOnly(
    M,
    'Intervalo de repaso imposible (0 días)',
    variant((input) => {
      input.topics[1].srsIntervalDays = 0;
    }),
    'srs_fuera_de_rango',
    'critico'
  );

  expectOnly(
    M,
    'Intervalo de repaso demasiado largo (500 días)',
    variant((input) => {
      input.topics[1].srsIntervalDays = 500;
    }),
    'srs_fuera_de_rango',
    'critico'
  );

  expectOnly(
    M,
    'Facilidad fuera del algoritmo (3.5)',
    variant((input) => {
      input.topics[1].srsEaseFactor = 3.5;
    }),
    'srs_fuera_de_rango',
    'critico'
  );

  expectOnly(
    M,
    'Facilidad que ni es un número (NaN)',
    variant((input) => {
      input.topics[1].srsEaseFactor = NaN;
    }),
    'srs_fuera_de_rango',
    'critico'
  );

  expectOnly(
    M,
    'Repaso fechado en el futuro',
    variant((input) => {
      input.topics[1].status = 'repasado';
      input.topics[1].lastReviewedAt = FUTURE_REVIEW;
    }),
    'repaso_en_el_futuro',
    'critico',
    (_target, findings) =>
      check('Y no se confunde con el estado incoherente', findingOf(findings, 'estado_incoherente') === null)
  );

  // Estados
  expectOnly(
    M,
    'Unidad «repasada» sin ningún repaso',
    variant((input) => {
      input.topics[1].status = 'repasado';
      input.topics[1].lastReviewedAt = null;
    }),
    'estado_incoherente',
    'info'
  );

  expectOnly(
    M,
    'Estado que el sistema no conoce',
    variant((input) => {
      input.topics[1].status = 'a_medias';
    }),
    'estado_desconocido',
    'aviso'
  );

  // Exámenes
  expectOnly(
    M,
    'Examen con fecha pasada sin cerrar',
    variant((input) => {
      input.exams.push({
        id: 'e2',
        title: 'Examen de septiembre',
        subjectName: 'Física',
        examDate: PAST_EXAM,
        isCompleted: false,
      });
    }),
    'examenes_caducados',
    'info'
  );

  // Hábitos
  expectOnly(
    M,
    'Racha de hábito en negativo',
    variant((input) => {
      input.habits[0].streak = -2;
    }),
    'racha_negativa',
    'info'
  );

  expectOnly(
    M,
    'Hábito marcado tres veces el mismo día',
    variant((input) => {
      input.habits[0].logsToday = 3;
      input.habits[0].extraLogIds = ['log-2', 'log-3'];
    }),
    'habitos_duplicados',
    'info',
    (target) =>
      check(
        'Cuenta los sobrantes (2), no los registros del día (3)',
        target.count === 2,
        `count=${target.count}`
      )
  );

  // Retos
  expectOnly(
    M,
    'Reto de una semana pasada que sigue «en juego»',
    variant((input) => {
      input.challenges.push({
        id: 'c0',
        weekKey: '2026-W41',
        weekStart: '2026-10-05T00:00:00',
        status: 'active',
        title: 'Reto de la semana pasada',
      });
    }),
    'retos_caducados',
    'aviso'
  );

  // Motor de IA
  expectOnly(
    M,
    'Sin ninguna clave de IA',
    variant((input) => {
      input.ai = { gemini: false, groq: false, availableModels: 0, coolingDown: 0 };
    }),
    'ia_sin_claves',
    'critico',
    (target) => check('Y avisa de que esto no se arregla solo', target.fixable === false)
  );

  expectOnly(
    M,
    'Todos los modelos en enfriamiento',
    variant((input) => {
      input.ai = { gemini: true, groq: false, availableModels: 0, coolingDown: 2 };
    }),
    'ia_saturada',
    'aviso',
    (target) => check('Cuenta los modelos en enfriamiento', target.count === 2, `count=${target.count}`)
  );

  expectOnly(
    M,
    'Algún modelo libre pero otros en enfriamiento',
    variant((input) => {
      input.ai = { gemini: true, groq: false, availableModels: 2, coolingDown: 1 };
    }),
    'ia_saturada',
    'info'
  );

  // Apuntes: restos de código dentro del texto
  expectOnly(
    M,
    'Apunte guardado con una valla y una etiqueta HTML dentro',
    variant((input) => {
      input.notes = [{ id: 'n1', title: 'Límites y continuidad', content: DIRTY_NOTE, author: 'catedratico' }];
    }),
    'apuntes_con_codigo',
    'aviso',
    (target) =>
      check(
        'Y dice qué le sobra al apunte',
        /valla de código/.test(target.samples.join(' ')) && /etiqueta HTML/.test(target.samples.join(' ')),
        target.samples.join(' · ')
      )
  );

  check(
    'Cada resto de código se reconoce por su nombre',
    M.noteCodeRemnants(DIRTY_NOTE).join(', ') === 'valla de código, etiqueta HTML' &&
      M.noteCodeRemnants('texto' + String.fromCharCode(92) + 'nmás').includes('salto de línea escapado') &&
      M.noteCodeRemnants('hola [[etapa:pista_1]]').includes('etiqueta interna del sistema') &&
      M.noteCodeRemnants(CLEAN_NOTE).length === 0,
    M.noteCodeRemnants(DIRTY_NOTE).join(', ')
  );

  check(
    'Un apunte con matemáticas no se confunde con código',
    M.noteCodeRemnants('Si x < y y z > 0, entonces k = 2*3 y el fichero es nombre_fichero.txt.').length === 0,
    M.noteCodeRemnants('Si x < y y z > 0, entonces k = 2*3 y el fichero es nombre_fichero.txt.').join(', ') || 'limpio'
  );

  // Incidencias
  expectOnly(
    M,
    'Fallo reportado sin revisar',
    variant((input) => {
      input.issues.push({ id: 'i2', title: 'La página de repaso iba lenta', status: 'abierto' });
    }),
    'incidencias_abiertas',
    'aviso',
    (target) =>
      check('Solo cuenta las abiertas, no las resueltas', target.count === 1, `count=${target.count}`)
  );

  // El aviso de incidencias no puede contarse a sí mismo. Antes sí lo hacía: el
  // vigilante abría «Fallos reportados sin revisar» y esa misma incidencia lo
  // mantenía abierto en cada ronda, así que el taller enseñaba un problema
  // permanente que no existía y nunca se cerraba solo.
  expectSilence(
    M,
    'Solo la incidencia que abre el propio aviso de incidencias',
    variant((input) => {
      input.issues.push({
        id: 'i-auto',
        title: '[auto] Fallos reportados sin revisar',
        status: 'abierto',
        findingId: 'incidencias_abiertas',
      });
    })
  );

  expectOnly(
    M,
    'Una incidencia real junto a la del propio aviso',
    variant((input) => {
      input.issues.push(
        {
          id: 'i-auto',
          title: '[auto] Fallos reportados sin revisar',
          status: 'abierto',
          findingId: 'incidencias_abiertas',
        },
        { id: 'i-real', title: 'La página de repaso iba lenta', status: 'abierto', findingId: null }
      );
    }),
    'incidencias_abiertas',
    'aviso',
    (target) => check('Cuenta la real y no la del aviso', target.count === 1, `count=${target.count}`)
  );

  section('3. Lo que está bien no debe sonar (casos que NO pueden avisar)');
  expectSilence(
    M,
    'Apunte limpio (Markdown y LaTeX, sin restos)',
    variant((input) => {
      input.notes = [{ id: 'n1', title: 'Límites y continuidad', content: CLEAN_NOTE, author: 'catedratico' }];
    })
  );
  expectSilence(
    M,
    'Incidencia revisada',
    variant((input) => {
      input.issues.push({ id: 'i2', title: 'Mirado y anotado', status: 'revisado' });
    })
  );
  expectSilence(
    M,
    'Reto de otra semana ya cerrado',
    variant((input) => {
      input.challenges.push({
        id: 'c0',
        weekKey: '2026-W41',
        weekStart: '2026-10-05T00:00:00',
        status: 'completed',
        title: 'Reto de la semana pasada',
      });
    })
  );
  expectSilence(
    M,
    'Reto de otra semana caducado',
    variant((input) => {
      input.challenges.push({
        id: 'c0',
        weekKey: '2026-W41',
        weekStart: '2026-10-05T00:00:00',
        status: 'expired',
        title: 'Reto de la semana pasada',
      });
    })
  );
  expectSilence(
    M,
    'Hábito del que no se anota ningún sobrante (manda extraLogIds, no el contador del día)',
    variant((input) => {
      input.habits[0].logsToday = 4;
      input.habits[0].extraLogIds = [];
    })
  );
  expectSilence(
    M,
    'Unidades medidas de verdad con su nivel',
    variant((input) => {
      input.topics[1].masteryLevel = 63;
      input.topics[1].masterySource = 'examen';
    })
  );

  section('4. El orden de la lista importa: lo crítico primero');
  const ordered = M.runMaintenanceChecks(
    variant((input) => {
      input.topics[1].title = '  Derivadas .'; // info
      input.habits[0].streak = -1; // info
      input.topics[1].srsIntervalDays = 0; // critico
      input.challenges.push({
        id: 'c0',
        weekKey: '2026-W41',
        weekStart: '2026-10-05T00:00:00',
        status: 'active',
        title: 'Reto viejo',
      }); // aviso
    })
  );
  // El orden se comprueba con rangos, no comparando el texto de la gravedad
  // («aviso» iría antes que «critico» solo por alfabeto).
  const RANK = { critico: 0, aviso: 1, info: 2 };
  check(
    'Se juntan las tres gravedades',
    new Set(ordered.map((finding) => finding.severity)).size === 3,
    ordered.map((finding) => finding.severity).join(' → ')
  );
  check('Lo crítico va primero', ordered.length > 0 && ordered[0].severity === 'critico', ordered[0] ? ordered[0].severity : '—');
  check(
    'Lo informativo va al final',
    ordered.length > 0 && ordered[ordered.length - 1].severity === 'info',
    ordered.length > 0 ? ordered[ordered.length - 1].severity : '—'
  );
  check(
    'Y las gravedades no bajan nunca: crítico → aviso → información',
    ordered.every((finding, index) => index === 0 || RANK[ordered[index - 1].severity] <= RANK[finding.severity]),
    ordered.map((finding) => finding.severity).join(' → ')
  );
}

/* ------------------------------------------------------------------ */
/* 5. Los arreglos                                                     */
/* ------------------------------------------------------------------ */

// Ids que el plan conoce. Los tres agregados no coinciden con el id de un
// hallazgo porque juntan varias comprobaciones en una sola pasada.
const AGGREGATE_PLANS = {
  renumerar_temario: ['numeracion_duplicada', 'numeracion_rota'],
  estados_incoherentes: ['estado_incoherente', 'estado_desconocido'],
};

const KNOWN_PLAN_IDS = [
  'apuntes_con_codigo',
  'temario_perdido',
  'titulos_sucios',
  'unidades_duplicadas',
  'renumerar_temario',
  'nivel_sin_medir',
  'srs_fuera_de_rango',
  'repaso_en_el_futuro',
  'estados_incoherentes',
  'examenes_caducados',
  'habitos_duplicados',
  'racha_negativa',
  'retos_caducados',
];

const KNOWN_OPERATIONS = [
  'clean_note_code',
  'restore_temario',
  'rename_topic',
  'renumber_topic',
  'delete_topic',
  'clamp_srs',
  'clear_future_review',
  'fix_topic_status',
  'reset_mastery',
  'delete_habit_log',
  'clamp_habit_streak',
  'expire_challenge',
  'complete_exam',
];

// Lo que puede vivir en un arreglo marcado como seguro. Cerrar un examen
// (marcarlo como realizado) no entra: cambia el estado del expediente y por eso
// el motor lo deja en manos del alumno.
const SAFE_OPERATIONS = [
  'clean_note_code',
  'restore_temario',
  'rename_topic',
  'renumber_topic',
  'delete_topic',
  'clamp_srs',
  'clear_future_review',
  'fix_topic_status',
  'reset_mastery',
  'delete_habit_log',
  'clamp_habit_streak',
  'expire_challenge',
];

/** Un expediente con casi todo roto: sirve para mirar los planes enteros. */
function kitchenSink() {
  return variant((input) => {
    input.topics[1].title = '  Derivadas  '; // títulos sucios (y sigue normalizando a «derivadas»)
    input.topics[1].unitNumber = 4; // hueco: 1, 4
    input.topics[1].srsIntervalDays = 0; // calendario imposible
    input.topics[1].masteryLevel = 88; // nivel sin medir
    input.topics.push(
      topic({
        id: 'm3',
        title: 'Derivadas',
        unitNumber: 5,
        attached: Object.assign({}, EMPTY_ATTACHED, { notes: 1 }),
      })
    ); // repetida CON datos
    input.topics.push(topic({ id: 'm4', title: 'Trigonometría', unitNumber: 5 })); // número repetido
    input.topics.push(topic({ id: 'm5', title: 'Estadística', unitNumber: null })); // sin numerar
    input.topics.push(
      topic({ id: 'm6', title: 'Repasada sin repaso', unitNumber: 6, status: 'repasado' })
    ); // estado incoherente
    input.topics.push(topic({ id: 'm7', title: 'Estado raro', unitNumber: 7, status: 'a_medias' })); // estado desconocido
    input.topics.push(
      topic({ id: 'm8', title: 'Repaso al futuro', unitNumber: 8, status: 'repasado', lastReviewedAt: FUTURE_REVIEW })
    ); // repaso en el futuro
    input.exams.push({
      id: 'e2',
      title: 'Examen de septiembre',
      subjectName: 'Física',
      examDate: PAST_EXAM,
      isCompleted: false,
    });
    input.habits[0].streak = -3;
    input.habits[0].logsToday = 3;
    input.habits[0].extraLogIds = ['log-2', 'log-3'];
    input.challenges.push({
      id: 'c0',
      weekKey: '2026-W41',
      weekStart: '2026-10-05T00:00:00',
      status: 'active',
      title: 'Reto de la semana pasada',
    });
    input.issues.push({ id: 'i2', title: 'Fallo reportado', status: 'abierto' });
    input.subjects.push({ id: 's-bio', name: 'Biología', order: 3, units: 0, classPeriods: 0 });
    input.notes = [{ id: 'n1', title: 'Apunte viejo con código', content: DIRTY_NOTE, author: 'catedratico' }];
  });
}

function fixesSection(M) {
  const sink = kitchenSink();
  const findings = M.runMaintenanceChecks(sink);
  const fixes = M.buildMaintenanceFixes(sink);

  const attachedById = new Map(
    sink.topics.map((row) => [
      row.id,
      row.attached.notes + row.attached.errors + row.attached.blocks + row.attached.sessions + row.attached.reviews,
    ])
  );
  const extraLogIds = new Set(sink.habits.flatMap((habit) => habit.extraLogIds || []));
  const currentWeekChallenge = sink.challenges.find((challenge) => challenge.weekKey === sink.weekKey)?.id;

  section('5. Los planes de arreglo: forma, cobertura y lo que nunca pueden borrar');

  check(
    'Todo arreglo tiene un id que el taller conoce',
    fixes.every((fix) => KNOWN_PLAN_IDS.includes(fix.id)),
    fixes.map((fix) => fix.id).join(', ')
  );
  check(
    'Cada id de arreglo o es un hallazgo suyo o es un agregado documentado',
    fixes.every(
      (fix) =>
        findings.some((finding) => finding.id === fix.id) ||
        Object.prototype.hasOwnProperty.call(AGGREGATE_PLANS, fix.id)
    ),
    fixes
      .filter(
        (fix) =>
          !findings.some((finding) => finding.id === fix.id) &&
          !Object.prototype.hasOwnProperty.call(AGGREGATE_PLANS, fix.id)
      )
      .map((fix) => fix.id)
      .join(', ') || 'todos cuadran'
  );
  check(
    'Un arreglo nunca se cuelga de un hallazgo que no se puede arreglar',
    fixes.every((fix) => {
      const own = findings.find((finding) => finding.id === fix.id);
      return own ? own.fixable : true;
    })
  );
  check(
    'Cada arreglo dice cuántas cosas cambia (count = operaciones)',
    fixes.every((fix) => fix.count === fix.operations.length),
    fixes.map((fix) => `${fix.id}:${fix.count}/${fix.operations.length}`).join(' · ')
  );
  check(
    'Cada arreglo se explica antes de aplicarlo',
    fixes.every((fix) => typeof fix.description === 'string' && fix.description.trim().length >= 20 && fix.label.trim().length > 0)
  );
  check(
    'Los planes solo usan operaciones que existen',
    fixes.every((fix) => fix.operations.every((operation) => KNOWN_OPERATIONS.includes(operation.kind))),
    [...new Set(fixes.flatMap((fix) => fix.operations.map((operation) => operation.kind)))].join(', ')
  );

  // La invariante que sostiene todo el taller.
  const deleteTopics = fixes.flatMap((fix) =>
    fix.operations.filter((operation) => operation.kind === 'delete_topic').map((operation) => ({ fix, operation }))
  );
  check(
    'Ningún arreglo borra una unidad con datos colgando',
    deleteTopics.every(({ operation }) => (attachedById.get(operation.topicId) ?? -1) === 0),
    deleteTopics
      .filter(({ operation }) => (attachedById.get(operation.topicId) ?? -1) !== 0)
      .map(({ operation }) => operation.topicId)
      .join(', ') || `${deleteTopics.length} borrado(s), todos vacíos`
  );
  check(
    'Y los borrados salen de unidades repetidas, no de un capricho',
    deleteTopics.length === 0 || findingOf(findings, 'unidades_duplicadas') !== null
  );

  const deleteLogs = fixes.flatMap((fix) =>
    fix.operations.filter((operation) => operation.kind === 'delete_habit_log').map((operation) => operation.logId)
  );
  check(
    'Los registros de hábito borrados son los sobrantes, nunca el primero',
    deleteLogs.every((logId) => extraLogIds.has(logId)),
    `${deleteLogs.join(', ') || 'ninguno'}`
  );

  check(
    'Lo que no es «safe» es solo cerrar exámenes pasados',
    fixes.filter((fix) => fix.safe === false).every((fix) => fix.id === 'examenes_caducados'),
    fixes.filter((fix) => fix.safe === false).map((fix) => fix.id).join(', ') || 'ninguno'
  );
  check(
    'Ningún arreglo seguro toca los exámenes',
    fixes
      .filter((fix) => fix.safe)
      .every((fix) => fix.operations.every((operation) => SAFE_OPERATIONS.includes(operation.kind) && operation.kind !== 'complete_exam'))
  );

  // Cobertura: si una regla se puede arreglar, su plan tiene que existir.
  const fixableFindings = findings.filter((finding) => finding.fixable);
  check(
    'Cada hallazgo arreglable tiene su plan (suyo o de un agregado)',
    fixableFindings.every((finding) =>
      fixes.some(
        (fix) =>
          fix.id === finding.id ||
          (AGGREGATE_PLANS[fix.id] || []).includes(finding.id)
      )
    ),
    fixableFindings
      .filter(
        (finding) =>
          !fixes.some((fix) => fix.id === finding.id || (AGGREGATE_PLANS[fix.id] || []).includes(finding.id))
      )
      .map((finding) => finding.id)
      .join(', ') || `${fixableFindings.length} arreglable(s)`
  );

  // Los valores concretos de los arreglos.
  const titleFix = fixes.find((fix) => fix.id === 'titulos_sucios');
  check(
    'Limpiar títulos deja el título limpio de verdad',
    titleFix !== undefined &&
      titleFix.operations.every(
        (operation) => operation.kind === 'rename_topic' && operation.title === M.tidyTitle(operation.title)
      )
  );

  const renumberFix = fixes.find((fix) => fix.id === 'renumerar_temario');
  const renumbered = renumberFix
    ? renumberFix.operations.map((operation) => operation.unitNumber)
    : [];
  check(
    'Renumerar deja la secuencia correlativa por asignatura',
    renumberFix !== undefined &&
      renumberFix.operations.every((operation) => operation.kind === 'renumber_topic') &&
      new Set(renumberFix.operations.map((operation) => operation.topicId)).size ===
        renumberFix.operations.length &&
      renumbered.every((value) => Number.isInteger(value) && value >= 1),
    renumbered.join(', ')
  );

  const masteryFix = fixes.find((fix) => fix.id === 'nivel_sin_medir');
  check(
    'Devolver el nivel a «sin medir» usa el valor de la casa (0)',
    masteryFix !== undefined &&
      masteryFix.operations.every(
        (operation) => operation.kind === 'reset_mastery' && operation.topicId === 'm2'
      ),
    masteryFix ? masteryFix.operations.map((operation) => operation.topicId).join(', ') : '—'
  );

  const srsFix = fixes.find((fix) => fix.id === 'srs_fuera_de_rango');
  check(
    'Acotar el calendario deja valores dentro del algoritmo',
    srsFix !== undefined &&
      srsFix.operations.every(
        (operation) =>
          operation.kind === 'clamp_srs' &&
          operation.intervalDays >= 1 &&
          operation.intervalDays <= 180 &&
          operation.easeFactor >= 1.3 &&
          operation.easeFactor <= 2.8
      ),
    srsFix
      ? srsFix.operations.map((operation) => `${operation.intervalDays}d/${operation.easeFactor}`).join(', ')
      : '—'
  );

  const streakFix = fixes.find((fix) => fix.id === 'racha_negativa');
  check(
    'La racha negativa queda a cero',
    streakFix !== undefined &&
      streakFix.operations.every(
        (operation) => operation.kind === 'clamp_habit_streak' && operation.streak === 0
      )
  );

  const noteFix = fixes.find((fix) => fix.id === 'apuntes_con_codigo');
  check(
    'Limpiar apuntes es seguro y apunta solo al apunte sucio',
    noteFix !== undefined &&
      noteFix.safe === true &&
      noteFix.operations.every(
        (operation) => operation.kind === 'clean_note_code' && operation.noteId === 'n1'
      ),
    noteFix ? noteFix.operations.map((operation) => operation.noteId).join(', ') : '—'
  );
  check(
    'Y no propone limpiar un apunte que ya está limpio',
    M.buildMaintenanceFixes(
      variant((input) => {
        input.notes = [{ id: 'n2', title: 'Limpio', content: CLEAN_NOTE, author: 'catedratico' }];
      })
    ).every((fix) => fix.id !== 'apuntes_con_codigo')
  );

  /* Reponer el temario: un solo arreglo, seguro, y solo para la materia vacía. */
  const conCopia = variant(sinTemarioConCopia);
  const perdidoFix = M.buildMaintenanceFixes(conCopia).find((fix) => fix.id === 'temario_perdido');
  check(
    'Reponer el temario es un arreglo seguro y de una sola pieza',
    perdidoFix !== undefined &&
      perdidoFix.safe === true &&
      perdidoFix.count === 1 &&
      perdidoFix.operations.length === 1 &&
      perdidoFix.operations[0].kind === 'restore_temario',
    perdidoFix ? `${perdidoFix.count} materia(s) · ${perdidoFix.operations.map((operation) => operation.kind).join(', ')}` : '—'
  );

  const perdidoFinding = findingOf(M.runMaintenanceChecks(conCopia), 'temario_perdido');
  check(
    'Y solo nombra la materia que se ha quedado sin temario',
    perdidoFinding !== null &&
      perdidoFinding.count === 1 &&
      /Física/.test(perdidoFinding.samples.join(' ')) &&
      !/Matemáticas/.test(perdidoFinding.samples.join(' ')),
    perdidoFinding ? perdidoFinding.samples.join(' · ') : '—'
  );

  {
    // El temario repuesto: la materia vuelve a tener sus unidades y el aviso se
    // va solo. Es la prueba de que el arreglo cierra el hallazgo que lo motivó.
    const repuesto = JSON.parse(JSON.stringify(conCopia));
    repuesto.subjects.find((subject) => subject.id === 's-fis').units = 1;
    repuesto.topics.push(
      topic({
        id: 'f1',
        subjectId: 's-fis',
        subjectName: 'Física',
        title: 'Cinemática',
        unitNumber: 1,
      })
    );
    check(
      'Con el temario repuesto el aviso desaparece (y no se repone dos veces)',
      findingOf(M.runMaintenanceChecks(repuesto), 'temario_perdido') === null &&
        M.buildMaintenanceFixes(repuesto).every((fix) => fix.id !== 'temario_perdido')
    );
  }

  const challengeFix = fixes.find((fix) => fix.id === 'retos_caducados');
  check(
    'Los retos de esta semana no se tocan',
    challengeFix !== undefined &&
      challengeFix.operations.every(
        (operation) => operation.kind === 'expire_challenge' && operation.challengeId !== currentWeekChallenge
      ),
    challengeFix ? challengeFix.operations.map((operation) => operation.challengeId).join(', ') : '—'
  );

  section('6. Las dos caras del duplicado (el caso que más se puede romper)');

  // Duplicada vacía: se puede borrar (y solo la copia de más).
  const emptyDup = variant((input) => {
    input.topics.push(topic({ id: 'm3', title: 'Derivadas', unitNumber: 3 }));
  });
  const emptyFixes = M.buildMaintenanceFixes(emptyDup);
  const emptyDupFix = emptyFixes.find((fix) => fix.id === 'unidades_duplicadas');
  check(
    'Con una repetida vacía sí hay plan de borrado',
    emptyDupFix !== undefined && emptyDupFix.safe === true,
    emptyDupFix ? `${emptyDupFix.operations.length} operación(es)` : 'sin plan'
  );
  check(
    'Y borra la copia de más, no la original',
    emptyDupFix !== undefined &&
      emptyDupFix.operations.every(
        (operation) => operation.kind === 'delete_topic' && operation.topicId === 'm3'
      ),
    emptyDupFix ? emptyDupFix.operations.map((operation) => operation.topicId).join(', ') : '—'
  );

  // Duplicada con datos: ni se propone borrarla ni se pierde nada.
  const loadedDup = variant((input) => {
    // Las dos copias tienen datos: la que sobraría (la que menos tiene) lleva un
    // error dentro, así que no se puede borrar sola ni de lejos.
    input.topics[1].attached = Object.assign({}, EMPTY_ATTACHED, { errors: 2 });
    input.topics.push(
      topic({
        id: 'm3',
        title: 'Derivadas',
        unitNumber: 3,
        attached: Object.assign({}, EMPTY_ATTACHED, { errors: 1 }),
      })
    );
  });
  const loadedFixes = M.buildMaintenanceFixes(loadedDup);
  const loadedDeletes = loadedFixes.flatMap((fix) =>
    fix.operations.filter((operation) => operation.kind === 'delete_topic').map((operation) => operation.topicId)
  );
  check(
    'Con una repetida CON datos, el motor no propone borrarla',
    loadedDeletes.every((topicId) => topicId !== 'm3'),
    loadedDeletes.join(', ') || 'ningún borrado'
  );
  check(
    'Y el hallazgo avisa de que eso se fusiona a mano',
    (findingOf(M.runMaintenanceChecks(loadedDup), 'unidades_duplicadas') || {}).severity === 'aviso'
  );
  check(
    'Ningún arreglo pierde la unidad que tiene los datos',
    loadedFixes.every((fix) =>
      fix.operations.every((operation) => operation.kind !== 'delete_topic' || operation.topicId !== 'm3')
    )
  );
}

/* ------------------------------------------------------------------ */
/* 7. Títulos, resumen y la semana                                     */
/* ------------------------------------------------------------------ */

function helpersSection(M) {
  section('7. Los títulos: acentos, espacios y signos de sobra');

  check('normalizeTitle quita acentos y dobles espacios', M.normalizeTitle('  Límites  y   CONTINUIDAD ') === 'limites y continuidad', M.normalizeTitle('  Límites  y   CONTINUIDAD '));
  check('normalizeTitle convierte la eñe sin dejarla rara', M.normalizeTitle('Año') === 'ano', M.normalizeTitle('Año'));
  check('tidyTitle colapsa los espacios de dentro', M.tidyTitle('Límites  y  continuidad') === 'Límites y continuidad', M.tidyTitle('Límites  y  continuidad'));
  check('tidyTitle quita el punto final', M.tidyTitle('Derivadas .') === 'Derivadas', M.tidyTitle('Derivadas .'));
  check('tidyTitle quita comas y guiones finales', M.tidyTitle('Integrales , - ') === 'Integrales', M.tidyTitle('Integrales , - '));
  check('tidyTitle no toca los guiones de dentro', M.tidyTitle('Modelo 2019-2020') === 'Modelo 2019-2020', M.tidyTitle('Modelo 2019-2020'));
  check(
    'Los títulos vacíos o de solo espacios no revientan',
    M.tidyTitle('   \t') === '' && M.tidyTitle('') === '' && M.normalizeTitle('   ') === ''
  );
  const dirty = '  Derivadas .';
  check(
    'Limpiar dos veces no cambia nada más (tidyTitle es idempotente)',
    M.tidyTitle(M.tidyTitle(dirty)) === M.tidyTitle(dirty),
    `«${dirty}» → «${M.tidyTitle(dirty)}»`
  );

  section('8. El resumen de una pasada');

  const cleanSummary = M.summarizeFindings(M.runMaintenanceChecks(healthy()));
  check(
    'Sin hallazgos, todo a cero',
    cleanSummary.total === 0 && cleanSummary.critico === 0 && cleanSummary.aviso === 0 && cleanSummary.info === 0 && cleanSummary.fixable === 0,
    JSON.stringify(cleanSummary)
  );

  const sinkFindings = M.runMaintenanceChecks(kitchenSink());
  const sinkSummary = M.summarizeFindings(sinkFindings);
  check(
    'La suma por gravedad cuadra con el total',
    sinkSummary.critico + sinkSummary.aviso + sinkSummary.info === sinkSummary.total &&
      sinkSummary.total === sinkFindings.length,
    `${sinkSummary.critico}+${sinkSummary.aviso}+${sinkSummary.info} = ${sinkSummary.total}`
  );
  check(
    'Y «arreglables» cuenta solo los que se pueden arreglar',
    sinkSummary.fixable === sinkFindings.filter((finding) => finding.fixable).length,
    `${sinkSummary.fixable} de ${sinkSummary.total}`
  );

  section('9. La semana de los retos se compara por su clave');

  const stale = M.runMaintenanceChecks(
    variant((input) => {
      input.challenges.push({
        id: 'c0',
        weekKey: '2026-W41',
        weekStart: '2026-10-05T00:00:00',
        status: 'active',
        title: 'Reto de la semana pasada',
      });
    })
  ).find((finding) => finding.id === 'retos_caducados');
  check('Un reto activo de otra semana se detecta', stale !== undefined);
  check(
    'Y el ejemplo dice de qué semana habla',
    stale !== undefined && stale.samples.some((sample) => sample.includes('2026-W41')),
    stale ? stale.samples.join(' · ') : '—'
  );

  const nextWeek = M.runMaintenanceChecks(
    variant((input) => {
      input.challenges.push({
        id: 'c9',
        weekKey: '2026-W43',
        weekStart: '2026-10-19T00:00:00',
        status: 'active',
        title: 'Reto adelantado',
      });
    })
  ).find((finding) => finding.id === 'retos_caducados');
  check(
    'Un reto de la semana que viene también cuenta como «no es la actual»',
    nextWeek !== undefined,
    'la comparación es por clave de semana, no por fecha'
  );

  const sameWeek = M.runMaintenanceChecks(healthy()).find((finding) => finding.id === 'retos_caducados');
  check('El de la semana en curso no se toca', sameWeek === undefined);
}

/* ------------------------------------------------------------------ */
/* El rastro de funcionamiento (caídas, errores y la IA)                */
/* ------------------------------------------------------------------ */

/**
 * Carga un módulo de `src/lib` que sea puro, transpilándolo en memoria. El
 * rastro de funcionamiento solo importa tipos, así que se puede probar con un log
 * de mentira: sin Prisma, sin red y sin que la app esté en marcha (que es justo
 * cuando más falta hace que estas comprobaciones funcionen).
 */
function loadPureTs(relativePath) {
  const file = path.join(projectRoot, 'src', 'lib', relativePath);
  const source = fs.readFileSync(file, 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  new Function('exports', 'module', js)(module.exports, module);
  return module.exports;
}

/**
 * Las comprobaciones que responden a «¿y si yo no estoy delante?»: el sistema
 * tiene que darse cuenta solo de que se ha caído, de que va mal y de que la IA
 * está fallando. Aquí se prueban con logs de mentira, con la hora fija, para que
 * el resultado no dependa del reloj ni de que haya pasado algo de verdad.
 */
function traceSection() {
  section('11. El rastro de funcionamiento (caídas, errores y la IA)');

  const O = loadPureTs('operationalTrace.ts');
  const NOW = new Date('2026-10-14T16:00:00Z');
  const build = (serverLog, vigilanteLog, appLog) =>
    O.buildTrace({ serverLog, vigilanteLog, appLog, now: NOW });
  const find = (trace) => O.runOperationalChecks(trace, NOW);
  const fixesOf = (trace) => O.buildOperationalFixes(trace, find(trace), NOW);
  const finding = (findings, id) => findings.find((item) => item.id === id);

  /* --- Un bucle de caídas reciente --- */
  const caidas = [
    '[2026-10-14 15:40:12] el servidor ha terminado (código 3221225794, señal -). Se reinicia.',
    '[2026-10-14 15:45:30] salud: sin respuesta (1/3)',
    '[2026-10-14 15:50:44] el servidor ha terminado (código 3221225794, señal -). Se reinicia.',
    '[2026-10-14 15:55:02] el servidor ha terminado (código 3221225794, señal -). Se reinicia.',
  ].join('\n');

  const bucle = build(caidas, null, null);
  check('Las caídas del servidor se cuentan', bucle.crashes.length === 3, `${bucle.crashes.length} caída(s)`);
  check(
    'Y la falta de salud con ellas',
    bucle.healthFailures.length === 1 && bucle.lastHealthState === 'fail',
    `${bucle.healthFailures.length} aviso(s) · último estado: ${bucle.lastHealthState}`
  );

  const bucleFindings = find(bucle);
  const inestable = finding(bucleFindings, 'servidor_inestable');
  check('Un bucle reciente es un problema crítico', inestable?.severity === 'critico', inestable?.severity);
  check(
    'Y dice el motivo real, no un «algo fue mal»',
    Boolean(inestable?.detail.includes('0xC0000142')),
    'el código de salida se traduce'
  );
  check(
    'Y trae la hora exacta de cada caída',
    Boolean(inestable?.samples.some((sample) => sample.includes('15:55'))),
    inestable?.samples[0]
  );

  const bucleFixes = fixesOf(bucle);
  const reinicio = bucleFixes.find((fix) => fix.id === 'servidor_inestable');
  check(
    'Se propone reiniciar la app para desatascarla',
    reinicio?.operations[0]?.kind === 'restart_server',
    reinicio?.operations[0]?.kind
  );
  check('Y es seguro: reiniciar no puede perder nada', reinicio?.safe === true);

  /* --- El reinicio que pide el sistema no es una caída (nada de bucles) --- */
  const pedido = build(
    [
      '[2026-10-14 15:55:00] reinicio pedido por el mantenimiento: cerrando el proceso 10816 para que arranque limpio',
      '[2026-10-14 15:55:01] el servidor ha terminado (código 1, señal -). Se reinicia.',
      '[2026-10-14 15:55:03] arrancando: node next dev -p 3000',
      '[2026-10-14 15:55:08] Ready in 4.1s',
    ].join('\n'),
    null,
    null
  );
  check(
    'La parada que ha pedido el mantenimiento no se cuenta como caída',
    pedido.crashes.length === 0 && pedido.intentionalRestarts.length === 1,
    `${pedido.crashes.length} caída(s) y ${pedido.intentionalRestarts.length} reinicio(s) intencionado(s)`
  );
  check(
    'Y por su propio arreglo no vuelve a reiniciar (nada de bucles)',
    fixesOf(pedido).every((fix) => fix.id !== 'servidor_inestable') &&
      O.restartIsJustified(pedido, NOW) === false,
    `${fixesOf(pedido).length} arreglo(s) propuesto(s)`
  );
  check(
    'Un bucle de caídas de verdad sí justifica reiniciar',
    O.restartIsJustified(bucle, NOW) === true,
    'tres caídas en la última media hora, sin reinicio previo'
  );
  const yaReiniciado = build(
    [
      '[2026-10-14 15:40:00] el servidor ha terminado (código 3221225794, señal -). Se reinicia.',
      '[2026-10-14 15:50:00] el servidor ha terminado (código 3221225794, señal -). Se reinicia.',
      '[2026-10-14 15:58:00] reinicio pedido por el mantenimiento: cerrando el proceso 10816',
      '[2026-10-14 15:58:01] el servidor ha terminado (código 1, señal -). Se reinicia.',
    ].join('\n'),
    null,
    null
  );
  check(
    'Tras un arreglo no se repite hasta media hora después',
    O.restartIsJustified(yaReiniciado, NOW) === false,
    'los dos reinicios son del mismo bucle: ya se ha hecho una vez'
  );
  check(
    'Y queda a la vista en el taller, no a escondidas',
    finding(find(pedido), 'reinicios_pedidos')?.severity === 'info',
    finding(find(pedido), 'reinicios_pedidos')?.title
  );
  const caidaSinMarca = build(
    [
      '[2026-10-14 15:55:00] reinicio pedido por el mantenimiento: cerrando el proceso 10816',
      '[2026-10-14 15:55:01] el servidor ha terminado (código 1, señal -). Se reinicia.',
      '[2026-10-14 15:58:30] el servidor ha terminado (código 3221225794, señal -). Se reinicia.',
    ].join('\n'),
    null,
    null
  );
  check(
    'Una caída de verdad (sin marca) sí se cuenta',
    caidaSinMarca.crashes.length === 1 && caidaSinMarca.intentionalRestarts.length === 1,
    `${caidaSinMarca.crashes.length} caída(s) real(es)`
  );

  /* --- Lo viejo es historial, no un fallo de ahora --- */
  const viejo = build(
    [
      '[2026-10-14 05:00:00] el servidor ha terminado (código 3221225786, señal SIGTERM). Se reinicia.',
      '[2026-10-14 11:00:00] el servidor ha terminado (código 3200000000, señal -). Se reinicia.',
    ].join('\n'),
    null,
    null
  );
  check(
    'El rastro guarda lo que hay en el log, con su hora',
    viejo.crashes.length === 2,
    `${viejo.crashes.length} caída(s) en el log`
  );
  check(
    'Y el hallazgo solo cuenta las de la ventana (6 h)',
    find(viejo).find((item) => item.id === 'servidor_inestable')?.count === 1,
    'la de las 05:00 queda fuera, la de las 11:00 dentro'
  );
  const viejoFixes = fixesOf(viejo);
  check(
    'Y una caída vieja no dispara un reinicio',
    viejoFixes.every((fix) => fix.id !== 'servidor_inestable'),
    `${viejoFixes.length} arreglo(s) propuesto(s)`
  );
  const controlC = viejo.crashes.find((entry) => entry.text.includes('3221225786'));
  check(
    'El cierre a mano se explica como tal',
    controlC ? O.describeExitCode(controlC)?.startsWith('alguien cerró') === true : false,
    controlC ? O.describeExitCode(controlC) : 'no se ha encontrado la línea'
  );

  /* --- La app dejó de responder --- */
  const caida = build('[2026-10-14 15:58:00] salud: sin respuesta (3/3)', null, null);
  const caidaFindings = find(caida);
  const sinRespuesta = finding(caidaFindings, 'servidor_caido');
  check('Si la salud se queda en fallo, la app está caída', sinRespuesta?.severity === 'critico');
  check(
    'Y se levanta el servidor vigilado sin preguntar',
    fixesOf(caida).some((fix) => fix.operations[0]?.kind === 'start_server')
  );
  const recuperada = build(
    [
      '[2026-10-14 15:58:00] salud: sin respuesta (3/3)',
      '[2026-10-14 15:59:30] la app vuelve a responder con normalidad.',
    ].join('\n'),
    null,
    null
  );
  check(
    'Y si vuelve sola, el hallazgo desaparece',
    finding(find(recuperada), 'servidor_caido') === undefined
  );

  /* --- La IA fallando --- */
  // Tal y como los escribe el motor de IA: sin hora propia, heredando la de la
  // última línea con sello (esa forma fue justo la que se me escapó).
  const iaLog = [
    '[2026-10-14 15:36:00] revisión: 3 hallazgo(s)',
    '[ia] gemini:gemini-3.8-flash falló (error, HTTP 502) tras 3 intentos: high demand',
    '[ia] gemini:gemini-3.6-flash falló (quota, HTTP 429): exceeded a quota',
    '[ia] groq:llama-3.3-70b falló (quota, HTTP 429): rate limit',
    '[2026-10-14 05:00:00] revisión de la madrugada',
    '[ia] gemini:gemini-2.0-flash falló (error, HTTP 500) tras 2 intentos: viejo',
  ].join('\n');
  const ia = build(null, iaLog, null);
  check(
    'De cada fallo de IA se saca el modelo, el motivo y el código',
    ia.aiFailures[0]?.provider === 'gemini' &&
      ia.aiFailures[0]?.model === 'gemini-3.8-flash' &&
      ia.aiFailures[0]?.kind === 'error' &&
      ia.aiFailures[0]?.httpStatus === 502 &&
      ia.aiFailures[0]?.attempts === 3,
    `${ia.aiFailures[0]?.provider}/${ia.aiFailures[0]?.model} · ${ia.aiFailures[0]?.kind} · HTTP ${ia.aiFailures[0]?.httpStatus}`
  );
  check(
    'El rastro guarda los 4 fallos, con su hora',
    ia.aiFailures.length === 4,
    `${ia.aiFailures.length} fallo(s) en el log`
  );
  check(
    'Y el hallazgo solo cuenta los de las últimas 2 horas',
    ia.aiFailures.filter((entry) => NOW.getTime() - new Date(entry.at).getTime() <= 2 * 3600000).length === 3,
    'el de la madrugada queda fuera: los cupos se recuperan solos'
  );
  const iaFinding = finding(find(ia), 'ia_fallando');
  check('Los fallos de IA salen como hallazgo', iaFinding?.count === 3, iaFinding?.title);
  check(
    'Y dicen de qué proveedor y cuántas veces',
    Boolean(iaFinding?.detail.includes('gemini ×2') && iaFinding?.detail.includes('groq ×1')),
    'reparto por proveedor'
  );
  check('Los fallos de IA no se «arreglan» a lo loco', iaFinding?.fixable === false);

  /* --- Errores de la propia app --- */
  const unError = build(
    '   ▲ Next.js 15.1.7\n[2026-10-14 15:50:00] Ready in 3.4s',
    null,
    '[2026-10-14 15:52:00] POST /temario · TypeError: x is not a function'
  );
  check('Un error registrado por la app se cuenta tal cual', unError.appErrors.length === 1, unError.appErrors[0]?.text);
  const tresErrores = build(
    '[2026-10-14 15:30:00] Ready in 3.4s',
    null,
    [
      '[2026-10-14 15:52:00] POST /temario · TypeError: x is not a function',
      '[2026-10-14 15:53:00] GET /repaso · ReferenceError: y is not defined',
      '[2026-10-14 15:54:00] POST /planificador · TypeError: z is not a function',
    ].join('\n')
  );
  check(
    'Repetido, un error de la app pasa a crítico',
    finding(find(tresErrores), 'errores_de_app')?.severity === 'critico',
    `${tresErrores.appErrors.length} errores`
  );

  /* --- Lo que una ronda no pudo terminar --- */
  const ronda = build(
    null,
    '[2026-10-14 15:20:00] ERROR al cargar los datos: timeout',
    null
  );
  check(
    'Una ronda que no termina se cuenta como revisión que no se hizo',
    finding(find(ronda), 'ronda_incompleta')?.count === 1
  );

  /* --- Un sistema sano no inventa nada --- */
  const sano = build(
    '[2026-10-14 15:26:36] arrancando: node next dev -p 3000\n   ▲ Next.js 15.1.7\n[2026-10-14 15:26:39] Ready in 3.4s',
    '[2026-10-14 15:36:51] app OK (27 ms) · 1 hallazgo(s) pendiente(s)',
    null
  );
  check('Un sistema sano no inventa hallazgos de funcionamiento', find(sano).length === 0, `${find(sano).length} hallazgo(s)`);
  check('Y no propone ningún arreglo', fixesOf(sano).length === 0);
}

/* ------------------------------------------------------------------ */
/* La parte viva: la ronda de verdad contra la base y la app            */
/* ------------------------------------------------------------------ */

/** Foto de todas las unidades que NO son de la prueba, para probar que nadie las toca. */
async function snapshotRealTopics(prisma, marca) {
  const topics = await prisma.topic.findMany({
    where: { subject: { name: { not: marca } } },
    select: {
      id: true,
      title: true,
      unitNumber: true,
      status: true,
      masteryLevel: true,
      masterySource: true,
      srsIntervalDays: true,
      srsEaseFactor: true,
    },
    orderBy: { id: 'asc' },
  });
  return topics.map((topic) =>
    [
      topic.id,
      topic.title,
      topic.unitNumber,
      topic.status,
      topic.masteryLevel,
      topic.masterySource,
      topic.srsIntervalDays,
      topic.srsEaseFactor,
    ].join('|')
  );
}

/** ¿Algún hallazgo habla de estos títulos? (los ejemplos los citan entre «»). */
function mentionsAny(findings, titles) {
  return findings.some((finding) =>
    finding.samples.some((sample) => titles.some((title) => sample.includes(title)))
  );
}

/**
 * La prueba de verdad: se rompe el temario **a propósito** en una asignatura
 * aparte, se lanza la ronda del vigilante y se comprueba que arregla lo que debe,
 * que no toca nada ajeno y que la deja como estaba.
 *
 * Nada de esto se queda en la base: al final se borra la asignatura de prueba
 * (en cascada con sus unidades) y se comprueba que el expediente real está
 * exactamente igual que al empezar.
 */
async function liveSection() {
  section('10. En vivo: la ronda contra la base y la app');

  const { compilaTs } = require('./lib/compilaTs');
  const APP = process.env.APP_URL || 'http://localhost:3000';
  const MARCA = 'ZZ verificación de mantenimiento';

  const outDir = compilaTs('vigilante.ts', '.tmp-verify-mantenimiento');
  const V = require(path.join(outDir, 'vigilante.js'));
  const { prisma } = require(path.join(outDir, 'prisma.js'));
  // El motor puro, para no escribir los números del algoritmo a mano.
  const M = loadMaintenanceModule();

  const silencio = () => {};
  // Para la recogida del final: qué incidencias ha abierto esta pasada.
  const inicio = new Date();

  try {
    /* La app y el taller -------------------------------------------------- */
    try {
      const salud = await fetch(`${APP}/api/salud`);
      const body = await salud.json();
      check(
        'La app responde y su base está bien',
        salud.status === 200 && body.ok === true,
        `HTTP ${salud.status} · ${body.database?.counts?.topics ?? '?'} unidades`
      );
    } catch (error) {
      check('La app responde y su base está bien', false, error.message);
    }

    try {
      const page = await fetch(`${APP}/mantenimiento`);
      const html = await page.text();
      check(
        'El taller se pinta (y no en blanco)',
        page.status === 200 && html.includes('antenimiento'),
        `HTTP ${page.status}`
      );
    } catch (error) {
      check('El taller se pinta (y no en blanco)', false, error.message);
    }

    /* El expediente real, antes de tocar nada ----------------------------- */
    const realBefore = await snapshotRealTopics(prisma, MARCA);

    const subject = await prisma.subject.create({
      data: { name: MARCA, order: 999, color: '#ef4444' },
    });

    const nuevo = (title, unitNumber, extra = {}) =>
      prisma.topic.create({
        data: {
          subjectId: subject.id,
          title,
          unitNumber,
          status: 'pendiente',
          difficulty: 3,
          ...extra,
        },
      });

    const sucio = await nuevo('  Límites y continuidad .', 1);
    const roto = await nuevo('Derivadas', 1, {
      masteryLevel: 88,
      srsIntervalDays: 0,
      srsEaseFactor: 3.5,
    });
    const repetida = await nuevo('Derivadas', 5);
    const descolgada = await nuevo('Integrales', 9);

    /* 1. En seco: lo detecta y no toca nada -------------------------------- */
    const dry = await V.runVigilanteCycle({ serverUrl: APP, dry: true, log: silencio });
    const dryIds = dry.findingsAfter.map((finding) => finding.id);
    check('La ronda en seco ve el temario sucio', dryIds.includes('titulos_sucios'));
    check('Y el nivel que aparenta una medición', dryIds.includes('nivel_sin_medir'));
    check('Y el calendario imposible', dryIds.includes('srs_fuera_de_rango'));
    check(
      'Y la numeración repetida o rota',
      dryIds.includes('numeracion_duplicada') || dryIds.includes('numeracion_rota')
    );
    check('Y la unidad repetida', dryIds.includes('unidades_duplicadas'));

    const trasSecoSucio = await prisma.topic.findUnique({ where: { id: sucio.id } });
    const trasSecoRoto = await prisma.topic.findUnique({ where: { id: roto.id } });
    check(
      'Y no ha escrito nada (la simulación es de verdad)',
      trasSecoSucio.title === '  Límites y continuidad .' &&
        trasSecoRoto.masteryLevel === 88 &&
        trasSecoRoto.srsIntervalDays === 0
    );

    /* 2. De verdad: arregla lo seguro y deja el resto ---------------------- */
    const real = await V.runVigilanteCycle({ serverUrl: APP, askAi: false, log: silencio });
    check(
      'La ronda aplica los arreglos seguros',
      real.applied.length > 0,
      real.applied.map((item) => `${item.label} (${item.count})`).join(' | ')
    );

    const limpio = await prisma.topic.findUnique({ where: { id: sucio.id } });
    const medido = await prisma.topic.findUnique({ where: { id: roto.id } });
    check('El título sucio queda limpio', limpio && limpio.title === 'Límites y continuidad', limpio?.title);
    check(
      'El nivel inventado vuelve a «sin medir»',
      medido && medido.masteryLevel === 0 && medido.masterySource === 'sin_medir',
      medido ? `${medido.masteryLevel} (${medido.masterySource})` : '—'
    );
    check(
      'El calendario queda dentro del algoritmo',
      medido &&
        medido.srsIntervalDays >= 1 &&
        medido.srsIntervalDays <= M.SRS_MAX_INTERVAL_DAYS &&
        medido.srsEaseFactor >= M.SRS_MIN_EASE &&
        medido.srsEaseFactor <= M.SRS_MAX_EASE,
      medido ? `${medido.srsIntervalDays}d / ${medido.srsEaseFactor}` : '—'
    );
    const quedan = await prisma.topic.findMany({ where: { subjectId: subject.id } });
    check(
      'La repetida vacía se ha ido sin llevarse nada por delante',
      quedan.length === 3 && !quedan.some((topic) => topic.id === repetida.id)
    );
    check(
      'Y el temario queda numerado del 1 al 3 sin huecos',
      quedan.map((topic) => topic.unitNumber).sort((a, b) => a - b).join(',') === '1,2,3',
      quedan.map((topic) => `${topic.unitNumber}:${topic.title}`).join(' · ')
    );

    /* 3. Lo que no se puede arreglar solo: se le pregunta a la IA ---------- */
    // Dos unidades con el mismo título y las DOS con datos dentro: eso no se
    // puede borrar sin decidir cuál se queda, así que es justo el caso que el
    // vigilante le pasa a la IA (y el que más daño haría si la IA se pasara).
    const conDatosA = await nuevo('Matrices', 4);
    const conDatosB = await nuevo('Matrices', 8);
    await prisma.note.create({
      data: {
        topicId: conDatosA.id,
        title: 'Matrices (1)',
        content: '# Matrices\n\nApunte de prueba.',
      },
    });
    await prisma.note.create({
      data: {
        topicId: conDatosB.id,
        title: 'Matrices (2)',
        content: '# Matrices\n\nOtro apunte de prueba.',
      },
    });

    const conIa = await V.runVigilanteCycle({ serverUrl: APP, log: silencio });
    check(
      'Con un duplicado con datos en las dos copias, se le pregunta a la IA',
      conIa.ai.asked === true || conIa.ai.error !== null,
      conIa.ai.asked ? `respondió ${conIa.ai.model}` : `sin IA: ${conIa.ai.error}`
    );
    const notasIntactas = await prisma.note.count({
      where: { topicId: { in: [conDatosA.id, conDatosB.id] } },
    });
    check(
      'Ninguna IA se lleva por delante datos del alumno',
      notasIntactas === 2,
      `${notasIntactas} de 2 apuntes siguen ahí`
    );
    const vivas = await prisma.topic.count({ where: { id: { in: [conDatosA.id, conDatosB.id] } } });
    check('Y ninguna unidad con datos ha desaparecido', vivas === 2, `${vivas} de 2`);

    // El guardián del borrado, por su interfaz real: aunque un plan pida borrar
    // una unidad, si esa unidad ya no está vacía (la foto cambió entre que se
    // decidió y se ejecutó) no se borra. Es la última red: el motor y la IA ya
    // prometen esto, y esto lo exige.
    const Apply = require(path.join(outDir, 'maintenanceApply.js'));
    const negado = await Apply.applyFixPlan(await getTestUserId(), [
      {
        id: 'prueba_guardian',
        label: 'Plan que pide borrar una unidad con datos dentro',
        description: 'Comprobación del guardián de borrado.',
        count: 1,
        safe: false,
        operations: [{ kind: 'delete_topic', topicId: conDatosA.id }],
      },
    ]);
    check(
      'El guardián del borrado se niega aunque un plan lo pida',
      (await prisma.topic.count({ where: { id: conDatosA.id } })) === 1 &&
        (await prisma.note.count({ where: { topicId: conDatosA.id } })) === 1 &&
        negado.applied.length === 0,
      negado.applied.length === 0 ? 'no ha borrado nada' : 'HA BORRADO la unidad con datos'
    );

    /* 4. Las incidencias: se abren solas y se cierran solas ---------------- */
    // Se prueba con un hallazgo de mentira en vez de esperar a que la IA deje
    // algo mal: así la comprobación es determinista y prueba exactamente el
    // bucle (abrir, no duplicar, cerrar cuando ya no se detecta).
    const hallazgoFalso = {
      id: 'prueba_vigilante',
      severity: 'aviso',
      title: 'Prueba de incidencia automática',
      detail: 'Comprobación de que el vigilante abre y cierra incidencias solo.',
      count: 1,
      fixable: false,
      samples: [],
    };
    const abrir = await V.syncIssues([hallazgoFalso], { log: silencio });
    check(
      'Lo que no se puede arreglar se apunta como incidencia',
      abrir.opened.length === 1,
      abrir.opened.join(' | ') || 'ninguna'
    );
    const repetir = await V.syncIssues([hallazgoFalso], { log: silencio });
    check('Y la ronda siguiente no la duplica', repetir.opened.length === 0, 'se empareja por el id de la comprobación');
    const cerrar = await V.syncIssues([], { log: silencio });
    check(
      'Y se cierra sola cuando la comprobación ya no la detecta',
      cerrar.resolved.length === 1,
      cerrar.resolved.join(' | ') || 'ninguna'
    );

    /* 5. Nada ajeno se ha movido ------------------------------------------ */
    const realAfter = await snapshotRealTopics(prisma, MARCA);
    const cambiadas = realAfter.filter((row, index) => row !== realBefore[index]);
    check(
      'Ninguna unidad del expediente real se ha tocado en toda la ronda',
      realAfter.length === realBefore.length && cambiadas.length === 0,
      cambiadas.length > 0 ? `${cambiadas.length} cambiada(s)` : `${realAfter.length} unidades intactas`
    );

    /* 6. Recogida: la asignatura de prueba desaparece --------------------- */
    await prisma.subject.delete({ where: { id: subject.id } });
    const idsDeLaPrueba = [sucio.id, roto.id, repetida.id, descolgada.id, conDatosA.id, conDatosB.id];
    check(
      'La asignatura de prueba se borra en cascada con sus unidades',
      (await prisma.topic.count({ where: { id: { in: idsDeLaPrueba } } })) === 0
    );

    const cierre = await V.runVigilanteCycle({ serverUrl: APP, askAi: false, log: silencio });
    check(
      'Y la ronda siguiente ya no encuentra nada de la prueba',
      !cierre.findingsAfter.some((finding) =>
        finding.samples.some((sample) => sample.includes(MARCA))
      ),
      cierre.findingsAfter.length === 0 ? 'expediente limpio' : `${cierre.findingsAfter.length} hallazgo(s) del sistema`
    );

    const realFinal = await snapshotRealTopics(prisma, MARCA);
    check(
      'El expediente queda exactamente como estaba',
      realFinal.length === realBefore.length && realFinal.every((row, index) => row === realBefore[index])
    );

    /* 7. El rastro de funcionamiento, leído de verdad --------------------- */
    // Aquí ya no hay logs de mentira: es lo que el sistema ve de sí mismo ahora.
    const Scan = require(path.join(outDir, 'maintenanceScan.js'));
    const Oper = require(path.join(outDir, 'operationalTrace.js'));
    const Data = require(path.join(outDir, 'maintenanceData.js'));
    const Control = require(path.join(outDir, 'serverControl.js'));

    const inputReal = await Data.loadMaintenanceInput(await getTestUserId());
    check(
      'El rastro se lee de los logs de verdad',
      inputReal.trace?.serverLogFound === true && typeof inputReal.trace?.serverLogAt === 'string',
      `última línea del log del servidor: ${inputReal.trace?.serverLogAt ?? '—'}`
    );
    check(
      'Y el registro de errores de la propia app está enganchado',
      Array.isArray(inputReal.trace?.appErrors),
      `${inputReal.trace?.appErrors?.length ?? 0} error(es) de app anotados`
    );

    const soloDatos = M.runMaintenanceChecks(inputReal).length;
    const delRastro = Oper.runOperationalChecks(inputReal.trace, new Date(inputReal.now)).length;
    check(
      'El motor une datos y funcionamiento sin perder ninguno',
      Scan.scanAll(inputReal).length === soloDatos + delRastro,
      `${soloDatos} de datos + ${delRastro} de funcionamiento`
    );

    const arreglos = Scan.allFixes(inputReal);
    check(
      'Cada arreglo dice si es seguro y qué hace antes de aplicarlo',
      arreglos.every(
        (fix) =>
          typeof fix.safe === 'boolean' && fix.label.length > 0 && fix.description.length > 0
      ),
      `${arreglos.length} arreglo(s) disponible(s)`
    );

    // El control del servidor se prueba sin reiniciar nada: con el vigilante en
    // marcha, lo correcto es **no tocar nada** (meter otro sería pelearse por el
    // puerto, y reiniciar la app desde su propio test no demuestra nada).
    const control = await Control.startWatchedServer();
    check('El control del servidor no toca nada si el vigilado ya está en marcha', control.acted === false, control.detail);
    check('Y la app responde cuando se le pregunta de verdad', (await Control.appResponds()) === true);
  } finally {
    // Pase lo que pase, la prueba no deja basura en la base.
    try {
      await prisma.subject.deleteMany({ where: { name: MARCA } });
      await prisma.systemIssue.deleteMany({
        where: { source: 'vigilante', title: { contains: 'Prueba de incidencia automática' } },
      });
      // El temario de mentira provoca hallazgos reales, y el vigilante los apunta
      // como incidencia (y los cierra cuando la prueba desaparece). Esas filas se
      // van con ella: en el taller tiene que quedar lo que pasa de verdad, no el
      // rastro de las verificaciones. Solo se tocan las creadas en esta pasada y
      // ya cerradas; una incidencia tuya abierta no se toca nunca.
      await prisma.systemIssue.deleteMany({
        where: {
          source: 'vigilante',
          status: 'resuelto',
          title: { startsWith: '[auto]' },
          createdAt: { gte: inicio },
        },
      });
    } catch {
      // Si falla la recogida, el siguiente diagnóstico (`npm run doctor`) lo dirá.
    }
    await prisma.$disconnect().catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* 12. Lo que reportas tú y el cuidado de Moodle                        */
/* ------------------------------------------------------------------ */

/**
 * El triaje de los reportes del alumno (`issueTriage.ts`) y el cuidado de la
 * conexión de Moodle (`moodleSelfHeal.ts`).
 *
 * Lo que se prueba aquí, y por qué así:
 *
 *   - **Las reglas del triaje, puras.** `parseTriageReply` decide qué arreglo
 *     corresponde a un reporte: un id de arreglo inventado por la IA no puede
 *     colarse, un reporte que no existe se ignora y un id cortado solo vale si es
 *     inequívoco. Estas son las que impiden que una alucinación toque el temario.
 *   - **El cuidado de Moodle, con un Moodle de mentira.** Se levanta un servidor
 *     local que primero rechaza la clave (como hace Moodle cuando caduca) y luego
 *     la acepta: se comprueba que la app la marca como caducada, que deja el aviso
 *     en el taller y que, cuando vuelve a valer, se sincroniza sola. Todo contra el
 *     servidor de prueba: la conexión de verdad del alumno no se toca (se guarda y
 *     se restaura tal cual, y si estuviera conectada el test se salta).
 */
async function reportsAndMoodleSection() {
  section('12. Lo que reportas tú y el cuidado de la conexión de Moodle');

  const { compilaTs } = require('./lib/compilaTs');
  const triageDir = compilaTs('issueTriage.ts', '.tmp-verify-triaje');
  // El motor de IA se sustituye ANTES de cargar el triaje: así la pasada en vivo
  // no gasta cuota y no puede, por una respuesta rara del modelo, reiniciar la app
  // o tocar el temario mientras se está verificando.
  const engine = require(path.join(triageDir, 'aiEngine.js'));
  let canned = '';
  engine.runAiText = async () => ({ text: canned, steps: [], model: 'modelo-de-prueba', provider: 'groq' });
  const T = require(path.join(triageDir, 'issueTriage.js'));
  const { prisma } = require(path.join(triageDir, 'prisma.js'));

  const moodleDir = compilaTs('moodleSelfHeal.ts', '.tmp-verify-moodle');
  const H = require(path.join(moodleDir, 'moodleSelfHeal.js'));
  const W = require(path.join(moodleDir, 'moodleWs.js'));

  try {
    /* --- Las reglas del triaje (puras) ---------------------------------- */
    const fixes = [
      { id: 'renumerar_temario', label: 'Renumerar', count: 2, safe: true, operations: [] },
      { id: 'unidades_duplicadas', label: 'Quitar la copia', count: 1, safe: true, operations: [] },
    ];
    const issues = [
      { id: 'aaaaaaaa-1111-4111-8111-111111111111', title: 'El temario está desordenado' },
      { id: 'bbbbbbbb-2222-4222-8222-222222222222', title: 'Tengo una unidad repetida' },
    ];

    const parsed = T.parseTriageReply(
      [
        'arreglo | aaaaaaaa-1111-4111-8111-111111111111 | renumerar_temario | la numeración está rota',
        'arreglo | bbbbbbbb-2222-4222-8222-222222222222 | arreglo_que_no_existe | inventado',
        'no | cccccccc-3333-4333-8333-333333333333 | ese reporte no existe',
        'arreglo | bbbbbbbb | unidades_duplicadas | id cortado pero inequívoco',
        'arreglo | aaaa | renumerar_temario | id demasiado corto para saber de quién habla',
      ].join('\n'),
      issues,
      fixes
    );
    check('Un reporte con su arreglo se entiende', parsed.some((decision) => decision.issueId.startsWith('aaaaaaaa') && decision.fixId === 'renumerar_temario'), JSON.stringify(parsed.map((decision) => decision.fixId)));
    check(
      'Un arreglo inventado por la IA no se acepta',
      parsed.every((decision) => decision.fixId === null || fixes.some((fix) => fix.id === decision.fixId))
    );
    check('Un reporte que no existe se ignora', parsed.every((decision) => issues.some((issue) => issue.id === decision.issueId)));
    check(
      'Un id copiado a medias se resuelve si es inequívoco',
      parsed.some((decision) => decision.issueId.startsWith('bbbbbbbb') && decision.fixId === 'unidades_duplicadas')
    );
    check(
      'Pero un trozo demasiado corto no se adivina (mejor no hacer nada que equivocarse)',
      parsed.filter((decision) => decision.fixId === 'renumerar_temario').length === 1
    );
    check('Cada reporte se decide una sola vez', new Set(parsed.map((decision) => decision.issueId)).size === parsed.length);
    check(
      '«no» con motivo también se entiende (y no lleva arreglo)',
      T.parseTriageReply('no | bbbbbbbb-2222-4222-8222-222222222222 | eso no lo arregla el taller', issues, fixes).every(
        (decision) => decision.action === 'no' && decision.fixId === null && decision.reason.length > 0
      )
    );
    check('Sin líneas con el formato acordado no se decide nada', T.parseTriageReply('Lo siento, no puedo ayudarte.', issues, fixes).length === 0);

    /* --- Moodle: la clave muerta y la clave viva ------------------------- */
    check('Un token caducado se reconoce', H.isDeadToken(new W.MoodleError('ha caducado', 'invalidtoken')) === true);
    check('Un fallo de red no se confunde con una clave caducada', H.isDeadToken(new W.MoodleError('sin red', 'network')) === false);
    check('Y un error cualquiera tampoco', H.isDeadToken(new Error('vaya')) === false);

    const health = await H.readMoodleHealth();
    check(
      'El estado de Moodle es coherente con lo que hay guardado (con conexión o sin ella)',
      health.connected ? ['ok', 'caducado', 'sin_comprobar'].includes(health.tokenState) : health.tokenState === 'sin_conectar',
      `conectado: ${health.connected} · clave: ${health.tokenState}`
    );
    check('Y siempre hay una frase que lo explique', typeof health.detail === 'string' && health.detail.length > 20, health.detail.slice(0, 80));

    if (!LIVE) {
      console.log('  (la parte viva de esta sección necesita la app y la base: se lanza con --live)');
      return;
    }

    /* --- En vivo: un reporte tuyo, atendido ----------------------------- */
    const report = await prisma.systemIssue.create({
      data: {
        title: 'ZZ verificación: la app tarda al cambiar de sección',
        detail: 'Cada vez que cambio de pantalla tarda bastante en abrirse.',
        source: 'alumno',
        status: 'abierto',
      },
    });

    try {
      // La IA contesta lo que contestaría de verdad: que eso no lo arregla el taller.
      canned = `no | ${report.id} | Eso es la velocidad de tu ordenador al montar las pantallas, no un dato roto del sistema. No hay nada que ordenar ni que borrar por nuestra parte.`;
      const result = await T.triageReportedIssues(await getTestUserId(), { log: () => {} });
      const after = await prisma.systemIssue.findUnique({ where: { id: report.id } });

      check('El reporte tuyo entra en la pasada', result.success === true && result.reviewed >= 1, `${result.reviewed} revisado(s) · ${result.model}`);
      check('Y deja de estar «abierto sin revisar»', after.status === 'revisado', after.status);
      check(
        'Con el diagnóstico escrito (dos frases, no un «no» seco)',
        typeof after.resolution === 'string' && after.resolution.length >= 30,
        String(after.resolution ?? '').slice(0, 100)
      );

      // Y si la IA propone un arreglo que no existe, no se toca nada.
      const before = await prisma.systemIssue.count();
      canned = `arreglo | ${report.id} | arreglo_inventado | da igual`;
      await T.triageReportedIssues(await getTestUserId(), { log: () => {} });
      check('Un arreglo inventado no cambia el estado del reporte', (await prisma.systemIssue.count()) === before);
    } finally {
      await prisma.systemIssue.deleteMany({ where: { id: report.id } });
    }

    /* --- En vivo: un Moodle de mentira ---------------------------------- */
    const http = require('http');
    const profile = await prisma.userProfile.findUnique({ where: { id: await getTestUserId() } });

    if (profile.moodleBaseUrl || profile.moodleToken) {
      console.log('  (omitido: ya tienes un Moodle conectado; no se toca lo que funciona)');
      return;
    }

    let phase = 'caducado';
    const fake = http.createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk) => {
        raw += chunk;
      });
      request.on('end', () => {
        const fn = (raw.match(/wsfunction=([^&]+)/) || [])[1] || '';
        response.setHeader('Content-Type', 'application/json');

        if (phase === 'caducado') {
          response.end(JSON.stringify({ errorcode: 'invalidtoken', message: 'Invalid token - token not found' }));
          return;
        }

        const answers = {
          core_webservice_get_site_info: {
            sitename: 'Moodle de prueba',
            username: 'ojeda',
            userid: 42,
            release: '4.1',
            functions: [{ name: 'core_webservice_get_site_info' }],
          },
          core_enrol_get_users_courses: [],
          core_course_get_contents: [],
          mod_assign_get_assignments: { courses: [] },
          mod_assign_get_submissions: { assignments: [] },
        };
        response.end(JSON.stringify(answers[decodeURIComponent(fn)] ?? []));
      });
    });

    await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
    const port = fake.address().port;

    try {
      await prisma.userProfile.update({
        where: { id: await getTestUserId() },
        data: {
          moodleBaseUrl: `http://127.0.0.1:${port}`,
          moodleToken: 'token-de-prueba-1234567890',
          moodleSiteName: null,
          moodleUserId: null,
          moodleConnectedAt: new Date(),
          moodleTokenState: null,
          moodleCheckedAt: null,
        },
      });

      const dead = await H.healMoodleConnection({ force: true, log: () => {} });
      const marked = await prisma.userProfile.findUnique({ where: { id: await getTestUserId() } });
      const aviso = await prisma.systemIssue.findFirst({
        where: { title: H.MOODLE_TOKEN_ISSUE_TITLE, status: { not: 'resuelto' } },
      });

      check('Una clave caducada se detecta al comprobarla', dead.tokenState === 'caducado' && dead.checked === true, dead.note);
      check('Y queda marcada en el perfil (Ajustes puede avisar)', marked.moodleTokenState === 'caducado' && marked.moodleCheckedAt !== null);
      check('Con su aviso en el taller, no en silencio', aviso !== null, aviso ? aviso.status : 'sin aviso');
      check(
        'Y diciendo qué tiene que hacer el alumno (no se puede pedir otra clave sin él)',
        String(aviso?.detail ?? '').includes('Ajustes'),
        String(aviso?.detail ?? '').slice(0, 80)
      );

      phase = 'viva';
      const alive = await H.healMoodleConnection({ force: true, log: () => {} });
      const resolved = await prisma.systemIssue.findFirst({
        where: { title: H.MOODLE_TOKEN_ISSUE_TITLE, status: { not: 'resuelto' } },
      });

      check('Cuando la clave vuelve a valer, se sincroniza sola', alive.tokenState === 'ok' && alive.synced === true, alive.note.slice(0, 90));
      check('Y el aviso se cierra solo', resolved === null);
      check('Sin inventarse cursos que Moodle no ha dado', (await prisma.moodleCourse.count()) === 0);
    } finally {
      fake.close();
      await prisma.userProfile.update({
        where: { id: await getTestUserId() },
        data: {
          moodleBaseUrl: profile.moodleBaseUrl,
          moodleToken: profile.moodleToken,
          moodleSiteName: profile.moodleSiteName,
          moodleUserId: profile.moodleUserId,
          moodleConnectedAt: profile.moodleConnectedAt,
          moodleTokenState: profile.moodleTokenState,
          moodleCheckedAt: profile.moodleCheckedAt,
          lastMoodleSync: profile.lastMoodleSync,
        },
      });
      await prisma.systemIssue.deleteMany({ where: { title: H.MOODLE_TOKEN_ISSUE_TITLE } });

      const restored = await prisma.userProfile.findUnique({ where: { id: await getTestUserId() } });
      check(
        'La conexión de verdad del alumno se queda como estaba',
        restored.moodleBaseUrl === null && restored.moodleToken === null && restored.moodleTokenState === profile.moodleTokenState,
        `baseUrl: ${restored.moodleBaseUrl ?? 'ninguna'} · clave guardada: ${Boolean(restored.moodleToken)}`
      );
    }
  } finally {
    await prisma.$disconnect().catch(() => {});
    // Las copias transpiladas que ha usado esta sección se borran aquí: son
    // temporales de verdad (se regeneran en cada pasada) y el proyecto no debería
    // acumular una carpeta por ejecución.
    for (const dir of [triageDir, moodleDir]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  }
}

/* ------------------------------------------------------------------ */
/* 13. Las copias del temario: la red que permite reponerlo            */
/* ------------------------------------------------------------------ */

/**
 * La red de seguridad del temario.
 *
 * Una regla que repone un temario perdido solo vale si de verdad hay algo de
 * donde tirar. Aquí se comprueba eso: que el módulo está, que el listado de
 * copias se puede leer y ordena de la más nueva a la más vieja, y que la copia
 * del día se escribe y aparece en el listado. Lo que **escribe en la base**
 * (reponer) se prueba con `--live`, midiendo antes y después que a ninguna
 * materia se le quitan unidades.
 */
async function temarioCopiesSection() {
  section('13. Las copias del temario y la reposición');

  const file = path.join(projectRoot, 'src', 'lib', 'temarioRestore.ts');
  check('El módulo de copias del temario existe', fs.existsSync(file));
  if (!fs.existsSync(file)) return;

  const { compilaTs } = require('./lib/compilaTs');
  let dir = null;

  try {
    dir = compilaTs('temarioRestore.ts', '.tmp-verify-temario');
    const R = require(path.join(dir, 'temarioRestore.js'));
    const { prisma } = require(path.join(dir, 'prisma.js'));

    check(
      'Expone las tres puertas con las que se le habla',
      typeof R.listTemarioBackups === 'function' &&
        typeof R.restoreEmptyTemarios === 'function' &&
        typeof R.snapshotTemarioIfStale === 'function'
    );

    const copias = R.listTemarioBackups();
    check(
      'El listado de copias se puede leer y va de la más nueva a la más vieja',
      Array.isArray(copias) &&
        copias.every(
          (backup, index) =>
            index === 0 || new Date(copias[index - 1].at).getTime() >= new Date(backup.at).getTime()
        ),
      `${copias.length} copia(s)`
    );
    check(
      'Y cada copia dice de qué materias es y cuántas unidades trae',
      copias.every(
        (backup) =>
          typeof backup.file === 'string' &&
          Array.isArray(backup.subjects) &&
          backup.subjects.every((name) => typeof name === 'string' && name.length > 0) &&
          Number.isInteger(backup.units)
      ),
      copias.length > 0 ? `la más nueva: ${path.basename(copias[0].file)} (${copias[0].units} u.)` : 'ninguna todavía'
    );

    // La copia del día: con 0 horas de caducidad se escribe siempre que haya
    // temario. Así se comprueba que la red existe de verdad, no solo la función.
    const creada = await R.snapshotTemarioIfStale(await getTestUserId(), 0).catch((error) => {
      check('La copia del día se puede escribir', false, error.message);
      return null;
    });

    if (typeof creada === 'string') {
      check('La copia del día se escribe en data/backups', fs.existsSync(creada), path.basename(creada));
      check(
        'Y el listado la reconoce como la más reciente',
        (R.listTemarioBackups()[0] || {}).file === creada,
        path.basename(creada)
      );
      // La copia de la prueba no se queda: se regenera cada vez que se lanza.
      try {
        fs.unlinkSync(creada);
      } catch {
        // Si no se puede borrar, no es un fallo de la app.
      }
    } else {
      console.log('  (no se ha escrito copia: no hay ningún temario que copiar todavía)');
    }

    if (!LIVE) {
      console.log('  (la reposición de verdad se prueba con --live: necesita la base)');
      return;
    }

    // Reponer es el único arreglo que vuelve a escribir datos: se mide antes y
    // después y ninguna materia con temario puede acabar con menos unidades.
    const antes = await prisma.subject.findMany({
      select: { name: true, _count: { select: { topics: true } } },
    });
    const resultado = await R.restoreEmptyTemarios('verificación del taller');
    const despues = await prisma.subject.findMany({
      select: { name: true, _count: { select: { topics: true } } },
    });

    const unidadesPorMateria = new Map(despues.map((subject) => [subject.name, subject._count.topics]));
    check(
      'Reponer el temario no le quita ni una unidad a ninguna materia',
      antes.every(
        (subject) => (unidadesPorMateria.get(subject.name) ?? 0) >= subject._count.topics
      ),
      antes
        .map((subject) => `${subject.name}: ${subject._count.topics}`)
        .join(' · ')
        .slice(0, 120)
    );
    check(
      'Y solo repone materias que estaban vacías',
      resultado.restored.every((done) => {
        const previa = antes.find((subject) => subject.name === done.subject);
        return previa !== undefined && previa._count.topics === 0;
      }),
      resultado.restored.length > 0
        ? resultado.restored.map((done) => `${done.subject}: ${done.units} u.`).join(' · ')
        : 'ninguna materia estaba vacía'
    );

    await prisma.$disconnect().catch(() => {});
  } catch (error) {
    // Que esta sección falle no puede tumbar la verificación entera: se apunta
    // como una comprobación en rojo y las demás siguen.
    check('La sección de copias del temario se ha podido ejecutar', false, error.message);
  } finally {
    try {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Las carpetas temporales se limpian solas en la siguiente pasada.
    }
  }
}

/* ------------------------------------------------------------------ */
/* Arranque                                                            */
/* ------------------------------------------------------------------ */

async function main() {
  console.log('VERIFICACIÓN DEL TALLER DE MANTENIMIENTO');
  console.log('========================================');

  section('0. El motor se puede probar aislado');
  const M = loadMaintenanceModule();
  check(
    'El motor es puro y expone sus dos puertas',
    typeof M.runMaintenanceChecks === 'function' && typeof M.buildMaintenanceFixes === 'function'
  );
  check(
    'Con las constantes del algoritmo presentes',
    typeof M.NEUTRAL_MASTERY_LEVEL === 'number' && typeof M.SRS_MAX_INTERVAL_DAYS === 'number'
  );

  checksSection(M);
  fixesSection(M);
  helpersSection(M);
  traceSection();
  await temarioCopiesSection();

  if (LIVE) {
    await liveSection();
  } else {
    section('10. Parte en vivo');
    console.log('  (omitido: la parte viva necesita la app levantada; se lanza con --live)');
  }

  // El triaje de los reportes y el cuidado de Moodle: las reglas se prueban
  // siempre; lo que habla con la base y con un Moodle de mentira, con --live.
  try {
    await reportsAndMoodleSection();
  } catch (error) {
    check('La sección de reportes y Moodle se ha podido ejecutar', false, error.message);
  }

  console.log('\n========================================');
  if (failures > 0) {
    console.log(`\u001b[31mFALLOS: ${failures}\u001b[0m`);
    for (const label of failed) console.log(`  · ${label}`);
    process.exitCode = 1;
    return;
  }
  console.log('\u001b[32mTODO EN VERDE\u001b[0m');
}

main().catch((error) => {
  console.error(`\n\u001b[31mFALLO: ${error.message}\u001b[0m`);
  process.exitCode = 1;
});
