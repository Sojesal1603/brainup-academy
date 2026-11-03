/**
 * Verifica que el temario está sano y que el sistema lo ve igual que tú:
 *
 *   1. Lectura del temario que pegas: pruebas reales del módulo
 *      `src/lib/temarioImport.ts` (transpilado y ejecutado aquí mismo).
 *   2. Integridad de datos: estados válidos, numeración única y sin saltos,
 *      coherencia entre «visto» y su fecha de clase y origen declarado.
 *   3. Diagnóstico por asignatura: cuántas unidades llevas, ritmo real de clase
 *      y fecha prevista de fin de temario (el mismo cálculo que usa la app).
 *   4. Rutas en vivo: /temario, /horario y / responden y pintan el temario real.
 *
 * Uso:
 *   npm run verify:temario
 *
 * Con el servidor de desarrollo levantado (npm run dev) comprueba además las
 * rutas; si no está, solo avisa de esa parte.
 */
const ts = require('typescript');
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const BASE_URL = process.env.BRAINUP_URL || 'http://localhost:3000';

const STATUSES = ['pendiente', 'en_curso', 'visto', 'repasado'];
const SOURCES = ['profesor', 'libro', 'manual', 'curriculo', 'ia', 'entrevista'];
const DAY_MS = 86400000;

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

function sortUnits(units) {
  return [...units].sort((a, b) => {
    const na = a.unitNumber ?? Number.MAX_SAFE_INTEGER;
    const nb = b.unitNumber ?? Number.MAX_SAFE_INTEGER;
    if (na !== nb) return na - nb;
    return a.title.localeCompare(b.title, 'es');
  });
}

function paceAndProjection(units, now) {
  const seen = units.filter((u) => u.status === 'visto' || u.status === 'repasado');
  const recent = units.filter(
    (u) => u.seenInClassAt && now.getTime() - new Date(u.seenInClassAt).getTime() <= 28 * DAY_MS
  );
  const pace = recent.length === 0 ? null : Math.round((recent.length / 4) * 10) / 10;
  const remaining = units.length - seen.length - units.filter((u) => u.status === 'en_curso').length;
  const weeks = pace && pace > 0 ? Math.round((remaining / pace) * 10) / 10 : null;
  return {
    seen: seen.length,
    pace,
    weeks,
    finish: weeks === null ? null : new Date(now.getTime() + weeks * 7 * DAY_MS),
  };
}

/** Carga `src/lib/temarioImport.ts` transpilado (no tiene dependencias). */
function loadImportModule() {
  const file = path.join(process.cwd(), 'src', 'lib', 'temarioImport.ts');
  const source = fs.readFileSync(file, 'utf8');
  if (/^\s*import\s/m.test(source)) {
    throw new Error('temarioImport.ts debería ser puro (sin imports) para poder probarlo aislado');
  }
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  new Function('exports', 'module', js)(module.exports, module);
  return module.exports;
}

/**
 * Pruebas del lector de índices: lo que pegas se convierte en unidades sin que
 * la app se invente ni una, y lo que no es una unidad no entra.
 */
function parserTests() {
  console.log('\n1. Lectura del temario que pegas (módulo aislado)');
  const T = loadImportModule();

  const sample = `# índice de mi profesor
1ª EVALUACIÓN
1. Números reales y radicales
2) Trigonometría: razones y ecuaciones [4]
- Vectores y rectas en el plano
Bloque II: Funciones

2ª evaluación
U4 Funciones: dominio, límites y continuidad (4/5)
Tema 5: Derivadas y sus aplicaciones
5. Derivadas y sus aplicaciones
La programación de esta materia incluye también la lectura de textos matemáticos y la resolución de problemas en contextos reales del entorno andaluz.
1.1 Radicales y potencias`;

  const parsed = T.parseTemarioText(sample);
  const titles = parsed.units.map((unit) => unit.title);

  const esperadas = [
    'Números reales y radicales',
    'Trigonometría: razones y ecuaciones',
    'Vectores y rectas en el plano',
    'Funciones: dominio, límites y continuidad',
    'Derivadas y sus aplicaciones',
    '1.1 Radicales y potencias',
  ];
  if (JSON.stringify(titles) !== JSON.stringify(esperadas)) {
    fail(`El lector no devuelve las unidades esperadas: ${JSON.stringify(titles)}`);
  } else {
    ok('Líneas con número, viñeta y prefijo «U4/Tema 5» → 6 unidades limpias');
  }

  if (parsed.units.filter((unit) => unit.term === 1).length !== 3) {
    fail('Las unidades de la 1ª evaluación no quedan asignadas a la evaluación 1');
  } else if (parsed.units.filter((unit) => unit.term === 2).length !== 3) {
    fail('Las unidades de la 2ª evaluación no quedan asignadas a la evaluación 2');
  } else {
    ok('Cabeceras de evaluación aplicadas a las unidades de detrás', '1ª: 3 · 2ª: 3');
  }

  if (parsed.units[1].difficulty !== 4 || parsed.units[3].difficulty !== 4) {
    fail(`La dificultad opcional no se lee ([4] y (4/5)): ${JSON.stringify(parsed.units.map((u) => u.difficulty))}`);
  } else {
    ok('Dificultad opcional leída y quitada del título', '[4] → 4 · (4/5) → 4');
  }

  if (parsed.duplicates.length !== 1) {
    fail(`Los títulos repetidos no se deduplican (${parsed.duplicates.length})`);
  } else {
    ok('Título repetido cargado una sola vez', '5. Derivadas y sus aplicaciones');
  }

  if (parsed.ignored.length !== 1 || !/programación/.test(parsed.ignored[0] ?? '')) {
    fail(`Un párrafo largo debería quedar fuera y avisarse (${JSON.stringify(parsed.ignored)}`);
  } else {
    ok('Un párrafo no se cuela como unidad: se avisa', '1 línea descartada');
  }

  if (parsed.headers.length !== 3) {
    fail(`Las cabeceras leídas no cuadran (${parsed.headers.length}): ${JSON.stringify(parsed.headers)}`);
  } else {
    ok('Cabeceras detectadas sin convertirse en unidades', parsed.headers.join(' · '));
  }

  const empty = T.parseTemarioText('   \n\n');
  if (empty.units.length !== 0) {
    fail('Un texto vacío no debería producir unidades');
  } else {
    ok('Texto vacío → ninguna unidad (la app te lo dirá)');
  }

  if (!T.isTemarioSource('profesor') || T.isTemarioSource('inventado')) {
    fail('El origen de la unidad no se valida (solo profesor, libro o manual)');
  } else {
    ok('Origen validado: profesor, libro o manual');
  }
}

async function checkIntegrity() {
  console.log('\n2. Integridad del temario');
  const subjects = await prisma.subject.findMany({
    include: { topics: true },
    orderBy: [{ order: 'asc' }, { name: 'asc' }],
  });

  let totalUnits = 0;
  let badStatus = 0;
  let badSource = 0;
  let duplicateNumbers = 0;
  let gaps = 0;
  let seenWithoutDate = 0;
  let enCursoCount = 0;

  for (const subject of subjects) {
    totalUnits += subject.topics.length;
    const numbers = subject.topics.map((t) => t.unitNumber).filter((n) => n !== null);
    const unique = new Set(numbers);
    if (unique.size !== numbers.length) {
      duplicateNumbers++;
      fail(`Números de unidad repetidos en ${subject.name}`);
    }
    const missing = subject.topics.filter((t) => t.unitNumber === null);
    if (missing.length > 0) {
      warn(`${subject.name}: ${missing.length} unidad(es) sin número de orden`);
    }
    const ordered = [...unique].sort((a, b) => a - b);
    const expected = ordered.map((_, index) => index + 1);
    if (JSON.stringify(ordered) !== JSON.stringify(expected)) {
      gaps++;
      warn(`${subject.name}: la numeración no es 1..${ordered.length} (saltos: ${ordered.join(', ')})`);
    }

    for (const topic of subject.topics) {
      if (!STATUSES.includes(topic.status)) {
        badStatus++;
        fail(`Estado desconocido «${topic.status}» en ${subject.name} · ${topic.title}`);
      }
      if (!SOURCES.includes(topic.source)) {
        badSource++;
        fail(`Origen desconocido «${topic.source}» en ${subject.name} · ${topic.title}`);
      }
      if ((topic.status === 'visto' || topic.status === 'repasado') && !topic.seenInClassAt) {
        seenWithoutDate++;
      }
      if (topic.status === 'en_curso') enCursoCount++;
    }

    // Una unidad «en curso» nunca puede estar detrás de una ya vista.
    const orderedUnits = sortUnits(subject.topics);
    const lastSeen = [...orderedUnits]
      .reverse()
      .find((t) => t.status === 'visto' || t.status === 'repasado');
    const enCurso = orderedUnits.find((t) => t.status === 'en_curso');
    if (lastSeen && enCurso) {
      if ((enCurso.unitNumber ?? 0) < (lastSeen.unitNumber ?? 0)) {
        warn(
          `${subject.name}: la unidad en curso (${enCurso.unitNumber ?? '?'}) va por detrás de la última vista (${lastSeen.unitNumber ?? '?'})`
        );
      }
    }
  }

  if (badStatus === 0 && duplicateNumbers === 0) {
    ok(`Estados y numeración correctos en ${subjects.length} asignaturas`, `${totalUnits} unidades`);
  }
  if (gaps === 0 && totalUnits > 0) ok('Numeración continua en todas las asignaturas');
  if (badSource === 0 && totalUnits > 0) {
    ok('Todas las unidades declaran de dónde salen', 'profesor, libro, manual, referencia o propuesta');
  }
  if (seenWithoutDate > 0) {
    warn(
      `${seenWithoutDate} unidad(es) marcadas como vistas sin fecha de clase (no cuentan para el ritmo)`
    );
  }
  if (enCursoCount > 0) {
    ok(`Unidades en curso ahora mismo: ${enCursoCount}`);
  } else {
    warn('No hay ninguna unidad «en curso»: el chequeo de clase aún no ha marcado nada');
  }

  return subjects;
}

function checkDiagnostics(subjects) {
  console.log('\n3. Diagnóstico por asignatura (mismo cálculo que la app)');
  const now = new Date();
  const courseEndYear = now.getMonth() >= 7 ? now.getFullYear() + 1 : now.getFullYear();
  const courseEnd = new Date(courseEndYear, 5, 20);

  const rows = subjects.map((subject) => {
    const units = sortUnits(subject.topics);
    const diag = paceAndProjection(units, now);
    return { name: subject.name, total: units.length, ...diag };
  });

  const withUnits = rows.filter((row) => row.total > 0);
  if (withUnits.length === 0) {
    // El temario lo aporta el alumno: sin unidades no hay nada que diagnosticar.
    warn('Ninguna asignatura tiene temario cargado: pega tu índice en /temario → «Cargar tu temario»');
    return rows;
  }

  console.log(
    `  ${'ASIGNATURA'.padEnd(34)} ${'VISTAS'.padStart(7)} ${'RITMO'.padStart(6)}  FIN PREVISTO`
  );
  for (const row of withUnits) {
    const pace = row.pace === null ? '—' : `${row.pace}/sem`;
    const finish = row.finish
      ? row.finish.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: '2-digit' })
      : 'sin datos';
    const late = row.finish && row.finish.getTime() > courseEnd.getTime() ? '  ⚠ después del curso' : '';
    console.log(
      `  ${row.name.padEnd(34)} ${`${row.seen}/${row.total}`.padStart(7)} ${pace.padStart(6)}  ${finish}${late}`
    );
  }

  ok(`${withUnits.length} asignaturas con temario cargado`, `${rows.reduce((a, r) => a + r.total, 0)} unidades`);
  return rows;
}

async function checkRoutes(rows) {
  console.log('\n4. Rutas en vivo');
  const routes = ['/', '/temario', '/horario', '/planificador'];
  const knownSubject = rows[0]?.name ?? null;

  for (const route of routes) {
    try {
      const response = await fetch(`${BASE_URL}${route}`, { redirect: 'follow' });
      if (!response.ok) {
        fail(`${route} respondió HTTP ${response.status}`);
        continue;
      }
      const html = await response.text();

      if (route === '/temario') {
        if (!html.toLowerCase().includes('avance de clase')) fail('/temario no muestra la cabecera del temario');
        else if (knownSubject && !html.includes(knownSubject)) {
          fail(`/temario no lista la asignatura ${knownSubject}`);
        } else {
          ok('/temario renderiza el temario real');
        }
      } else if (route === '/horario') {
        if (!html.includes('Cuadrícula semanal')) fail('/horario no pinta la cuadrícula');
        else ok('/horario responde con la cuadrícula');
      } else {
        ok(`${route} responde 200`);
      }
    } catch (error) {
      warn(`No pude consultar ${route} (${error.message}). ¿Está levantado npm run dev?`);
    }
  }
}

async function main() {
  console.log('VERIFICACIÓN DEL TEMARIO\n========================');

  parserTests();
  const subjects = await checkIntegrity();
  const rows = checkDiagnostics(subjects);
  await checkRoutes(rows);

  console.log('\n========================');
  if (problems.length > 0) {
    console.log(`\u001b[31mFALLOS: ${problems.length}\u001b[0m`);
    for (const problem of problems) console.log(`  · ${problem}`);
    process.exitCode = 1;
    return;
  }
  if (warnings.length > 0) {
    console.log(`\u001b[33mTODO EN VERDE con ${warnings.length} aviso(s)\u001b[0m`);
    for (const w of warnings) console.log(`  · ${w}`);
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
