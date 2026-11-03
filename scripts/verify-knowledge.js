/**
 * Verifica la capa de honestidad: que la app no se invente tu nivel ni tus notas.
 *
 *   1. Pruebas reales del módulo `src/lib/knowledge.ts` (se transpila y se
 *      ejecuta aquí mismo, sin depender del servidor):
 *        · una unidad sin medir no vale como «floja» (valor neutro, 50)
 *        · una nota sin declarar no se cita (nunca aparece el número de fábrica)
 *        · el expediente que recibe el catedrático dice «SIN DECLARAR» y
 *          «SIN MEDIR» en vez de inventarse debilidades
 *        · la etiqueta [[nivel:U4=55]] se parsea y se acepta/descarta bien
 *   2. Integridad de la base: ningún dominio > 0 sin origen de medición.
 *   3. Rutas: el Cuartel, el Planificador y el Temario hablan de «sin medir» y
 *      «sin declarar» donde antes mostraban números inventados.
 *   4. Opcional (`-- --live`): turno real de tutor en una materia sin mediciones
 *      comprobando que no cita notas ni debilidades inventadas (consume API).
 *
 * Uso:
 *   npm run verify:conocimiento
 *   npm run verify:conocimiento -- --live
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

function fail(label) {
  problems.push(label);
  console.log(`  \u001b[31m✗\u001b[0m ${label}`);
}

function warn(label) {
  warnings.push(label);
  console.log(`  \u001b[33m!\u001b[0m ${label}`);
}

/** Carga `src/lib/knowledge.ts` transpilado a JS (no tiene dependencias). */
function loadKnowledgeModule() {
  const file = path.join(process.cwd(), 'src', 'lib', 'knowledge.ts');
  const source = fs.readFileSync(file, 'utf8');
  if (/^\s*import\s/m.test(source)) {
    throw new Error('knowledge.ts debería ser puro (sin imports) para poder probarlo aislado');
  }
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  new Function('exports', 'module', js)(module.exports, module);
  return module.exports;
}

function unitTests() {
  console.log('\n1. Reglas de honestidad (módulo aislado)');
  const K = loadKnowledgeModule();

  // Una unidad sin medir no es débil: vale el punto medio.
  const blank = K.describeMastery({ masteryLevel: 0, masterySource: 'sin_medir' });
  if (blank.measured !== false || blank.effective !== K.NEUTRAL_MASTERY || blank.label !== 'sin medir') {
    fail(`Una unidad sin medir no se trata como neutra (effective=${blank.effective}, label=${blank.label})`);
  } else {
    ok('Unidad sin medir = valor neutro, nunca «0% flojo»', `effective=${blank.effective}`);
  }

  // Una unidad medida sí usa su valor.
  const measured = K.describeMastery({ masteryLevel: 42, masterySource: 'diagnostico' });
  if (!measured.measured || measured.effective !== 42 || measured.label !== '42%') {
    fail(`Una unidad medida no usa su valor real (${JSON.stringify(measured)})`);
  } else {
    ok('Unidad medida usa el valor medido', '42% · diagnosticado');
  }

  // La nota sin declarar no existe como dato.
  const blankGrade = K.describeGrade({ currentGrade: 7.5, gradeSource: 'sin_medir' });
  if (blankGrade.declared !== false || blankGrade.value !== null) {
    fail(`Una nota sin declarar sigue contando como dato (${JSON.stringify(blankGrade)})`);
  } else {
    ok('Nota sin declarar: no hay valor', `label=${blankGrade.label}`);
  }
  const declaredGrade = K.describeGrade({ currentGrade: 8.2, gradeSource: 'declarada' });
  if (!declaredGrade.declared || declaredGrade.value !== 8.2) {
    fail('Una nota declarada no se usa como dato');
  } else {
    ok('Nota declarada por el alumno: se usa', '8.2');
  }

  // El expediente del catedrático no puede inventar nada.
  const blankLines = K.buildStudentLevelLines({
    subjectName: 'Matemáticas I',
    grade: { currentGrade: 7.5, gradeSource: 'sin_medir' },
    targetGrade: 9.5,
    measuredTopics: [],
    unmeasuredCount: 14,
    courseUnit: { title: 'Trigonometría', unitNumber: 4, status: 'en_curso' },
  }).join('\n');

  if (/7[.,]5/.test(blankLines)) {
    fail('El expediente del catedrático cita una nota de fábrica (7.5) como si fuera tuya');
  } else {
    ok('Sin nota declarada, el catedrático no ve ninguna nota');
  }
  if (!/SIN DECLARAR/.test(blankLines) || !/SIN MEDIR/.test(blankLines)) {
    fail('El expediente no avisa al catedrático de que no hay mediciones');
  } else {
    ok('El expediente avisa: «SIN DECLARAR» + «SIN MEDIR»');
  }
  if (!/no las des por sabidas ni por flojas/i.test(blankLines)) {
    fail('Falta la orden explícita de no juzgar unidades sin medir');
  } else {
    ok('Orden explícita de no juzgar lo no medido');
  }
  if (!/Trigonometría/.test(blankLines)) {
    fail('El temario real (unidad en curso) no llega al catedrático');
  } else {
    ok('El dato real que sí existe (unidad en curso) sí se cita');
  }

  // Lo medido sí entra, con su origen.
  const measuredLines = K.buildStudentLevelLines({
    subjectName: 'Física y Química',
    grade: { currentGrade: 6.4, gradeSource: 'declarada' },
    targetGrade: 9.0,
    measuredTopics: [
      { title: 'Enlace químico', masteryLevel: 38, unitNumber: 3, source: 'autoevaluacion' },
      { title: 'Gases ideales', masteryLevel: 80, unitNumber: 7, source: 'simulacro' },
    ],
    unmeasuredCount: 14,
  }).join('\n');

  if (!/Enlace químico/.test(measuredLines) || !/38%/.test(measuredLines)) {
    fail('Una unidad medida floja no se cita al catedrático');
  } else {
    ok('Unidad medida floja sí se cita con su porcentaje y origen', '38% [autoevaluacion]');
  }
  if (/Gases ideales[\s\S]*por debajo/.test(measuredLines)) {
    fail('Una unidad medida y fuerte se presenta como floja');
  } else {
    ok('Las unidades medidas que van bien no se presentan como debilidad');
  }

  // Etiqueta de medición del catedrático.
  const parsed = K.parseLevelTag('[[etapa:verificacion]] Vamos bien.\n[[nivel:U4=55]]');
  if (!parsed.level || parsed.level.unitNumber !== 4 || parsed.level.mastery !== 55) {
    fail(`No se parsea [[nivel:U4=55]] (${JSON.stringify(parsed.level)})`);
  } else if (/nivel/.test(parsed.text)) {
    fail('La etiqueta de nivel no se limpia del texto visible');
  } else {
    ok('Etiqueta [[nivel:U4=55]] capturada y limpiada del mensaje');
  }
  const bogus = K.parseLevelTag('hola [[nivel:U4=150]]');
  if (bogus.level !== null) {
    fail('Se aceptó un nivel imposible (>100)');
  } else {
    ok('Niveles imposibles descartados', 'U4=150 → ignorado');
  }
}

async function dataIntegrity() {
  console.log('\n2. Integridad de los datos');

  const fakeLevels = await prisma.topic.findMany({
    where: { masteryLevel: { gt: 0 }, masterySource: 'sin_medir' },
    select: { title: true, masteryLevel: true },
  });
  if (fakeLevels.length > 0) {
    fail(`${fakeLevels.length} unidad(es) con nivel > 0 sin origen de medición`);
  } else {
    ok('Ningún nivel sin origen de medición');
  }

  const bySource = await prisma.topic.groupBy({ by: ['masterySource'], _count: true });
  console.log(
    '  niveles: ' + bySource.map((row) => `${row.masterySource}=${row._count}`).join(' · ')
  );

  const grades = await prisma.subject.groupBy({ by: ['gradeSource'], _count: true });
  console.log('  notas:   ' + grades.map((row) => `${row.gradeSource}=${row._count}`).join(' · '));

  const declared = grades.find((row) => row.gradeSource === 'declarada')?._count ?? 0;
  if (declared === 0) {
    warn('Todavía no has declarado ninguna nota: la proyección PAU se muestra como provisional');
  } else {
    ok(`Notas declaradas por ti: ${declared}`);
  }
}

async function routes() {
  console.log('\n3. Rutas en vivo');

  // El temario lo aporta el alumno: sin unidades no hay selectores de nivel que
  // mostrar, y la pantalla debe pedirle su índice en vez de inventar nada.
  const units = await prisma.topic.count();
  const temarioCheck =
    units > 0
      ? {
          route: '/temario',
          mustInclude: ['nivel sin medir'],
          label: 'Temario: nivel sin medir por unidad',
        }
      : {
          route: '/temario',
          mustInclude: ['Cargar tu temario', 'todavía no tiene temario'],
          label: 'Temario: sin unidades te pide el tuyo (no se inventa ninguna)',
        };

  // El Cuartel cambia de texto según haya o no niveles medidos: con datos, el
  // estado honesto es «N en zona de riesgo»; sin datos, «sin mediciones». Se
  // acepta el que toque según lo que hay en la base, en vez de exigir siempre el
  // mismo (esa comprobación se rompía sola en cuanto el alumno medía una unidad).
  const measured = await prisma.topic.count({ where: { masterySource: { not: 'sin_medir' } } });
  const cuartelCheck = {
    route: '/',
    mustInclude: measured > 0 ? ['zona de riesgo'] : ['sin mediciones'],
    label:
      measured > 0
        ? `Cuartel: estado honesto con ${measured} unidad(es) medidas`
        : 'Cuartel: estado honesto sin mediciones',
  };

  // La proyección de /estadisticas es la otra cara de lo mismo: **sin datos no
  // hay número** (se enseña un guión y «sin datos aún») y con datos se enseña el
  // número real con su base («sobre 14.000»). Exigir siempre el texto vacío sería
  // una prueba que se rompe sola en cuanto el alumno mide una unidad, igual que
  // pasaba en el Cuartel.
  /*
   * La proyección sobre 14 se calcula con las materias de FASE GENERAL (60/40
   * con el expediente): una unidad medida en una materia que no es de esa fase
   * —Tecnología, Dibujo…— **no** produce proyección, y eso es correcto. Antes
   * esta prueba miraba el total de unidades medidas de todo el curso, así que se
   * ponía roja en cuanto el alumno medía algo en una optativa (falso positivo:
   * el fallo estaba en la prueba, no en la página). Ahora se mira exactamente lo
   * que mira la página.
   */
  const generalWithData = await prisma.subject.count({
    where: {
      isPhaseGeneral: true,
      OR: [
        { gradeSource: { not: 'sin_medir' } },
        { topics: { some: { masterySource: { not: 'sin_medir' } } } },
      ],
    },
  });
  const declaredGrades = await prisma.subject.count({ where: { gradeSource: { not: 'sin_medir' } } });
  const hasForecast = generalWithData > 0;
  const statsCheck = {
    route: '/estadisticas',
    mustInclude: hasForecast ? ['sobre 14.000'] : ['sin datos aún'],
    label: hasForecast
      ? `Estadísticas: proyección con datos reales (${generalWithData} materia(s) de fase general con dato, ${measured} unidad(es) medidas, ${declaredGrades} nota(s) declarada(s))`
      : 'Estadísticas: sin datos = sin proyección',
  };

  const checks = [
    cuartelCheck,
    { route: '/planificador', mustInclude: ['sin declarar'], label: 'Planificador: nota sin declarar' },
    temarioCheck,
    { route: '/ajustes', mustInclude: ['notas reales'], label: 'Ajustes: panel de notas reales' },
    statsCheck,
  ];

  for (const check of checks) {
    try {
      const response = await fetch(`${BASE_URL}${check.route}`, { redirect: 'follow' });
      if (!response.ok) {
        fail(`${check.route} respondió HTTP ${response.status}`);
        continue;
      }
      const html = await response.text();
      const missing = check.mustInclude.filter((needle) => !html.toLowerCase().includes(needle.toLowerCase()));
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

async function liveTutor() {
  console.log('\n4. Turno real de tutor (--live)');

  const agent = await prisma.aiAgent.findFirst({ orderBy: { subject: { order: 'asc' } } });
  if (!agent) {
    warn('No hay catedráticos en la base');
    return;
  }

  try {
    const response = await fetch(`${BASE_URL}/api/tutor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: agent.id,
        // No escribir en el hilo real del alumno desde una verificación.
        fresh: true,
        message: 'Dime qué tal voy en esta materia y por dónde debería empezar hoy.',
      }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.reply?.content) {
      fail(`El tutor no respondió (HTTP ${response.status}): ${data?.error ?? 'sin detalle'}`);
      return;
    }

    const text = data.reply.content;
    console.log(`  modelo: ${data.model} · etapa: ${data.reply.stage}`);
    console.log(`  respuesta: ${text.slice(0, 220).replace(/\n/g, ' ')}…`);

    const inventedGrades = ['7.5', '7,5', '8.8', '8,8', '8.2', '8,2', '9.75'].filter((grade) =>
      text.includes(grade)
    );
    if (inventedGrades.length > 0) {
      fail(`El catedrático cita notas que nadie ha declarado: ${inventedGrades.join(', ')}`);
    } else {
      ok('El catedrático no cita ninguna nota inventada');
    }

    if (data.measured) {
      ok(
        `Medición anotada en la misma conversación: U${data.measured.unitNumber} = ${data.measured.mastery}%`
      );
    } else {
      console.log('  (esta vez no ha anotado medición: la etiqueta [[nivel:...]] es opcional)');
    }
  } catch (error) {
    fail(`No pude hablar con el tutor: ${error.message}`);
  }
}

async function main() {
  console.log('VERIFICACIÓN DE LA CAPA DE HONESTIDAD\n=====================================');
  unitTests();
  await dataIntegrity();
  await routes();
  if (LIVE) await liveTutor();
  else console.log('\n4. Turno real de tutor: omitido (usa `npm run verify:conocimiento -- --live`)');

  console.log('\n=====================================');
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
    console.error('FALLO:', error.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
