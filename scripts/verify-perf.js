/**
 * Verificación de la Fase 2: instantaneidad de navegación y `DailyBrief`.
 *
 * Comprueba, sin base de datos, sin red y sin sesión:
 *
 *   1. **Contrato**: el brief sale del plan, es determinista, incluye bloques,
 *      riesgos y próximo examen, y no llama a IA ni nombra proveedores.
 *   2. **Materialización**: la foto se guarda con `unstable_cache`, comparte las
 *      etiquetas del plan y dos aperturas del mismo minuto usan la misma clave.
 *   3. **Invalidación**: `invalidatePlan`, la energía y el recálculo purgan esas
 *      etiquetas; ningún cambio de estado espera al TTL.
 *   4. **Superficies**: el Cuartel, el planificador, apuntes y el hub de
 *      catedráticos leen de la caché; las páginas de lectura ya no fuerzan
 *      `force-dynamic` y las rutas siguen existiendo.
 *
 * Uso: `npm run verify:perf`.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { compilaTs, projectRoot } = require('./lib/compilaTs');

const outDir = compilaTs(['dailyBriefContract'], '.tmp-verify-perf');
const briefLib = require(path.join(outDir, 'dailyBriefContract.js'));

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

function stripComments(source) {
  let inBlock = false;
  return source
    .split('\n')
    .map((line) => {
      let text = line;
      if (inBlock) {
        const end = text.indexOf('*/');
        if (end < 0) return '';
        text = text.slice(end + 2);
        inBlock = false;
      }
      const start = text.indexOf('/*');
      if (start >= 0) {
        const end = text.indexOf('*/', start + 2);
        if (end < 0) {
          inBlock = true;
          text = text.slice(0, start);
        } else {
          text = `${text.slice(0, start)}${text.slice(end + 2)}`;
        }
      }
      if (text.trim().startsWith('//')) return '';
      return text;
    })
    .join('\n');
}

let checks = 0;
function ok(name, fn) {
  fn();
  checks += 1;
  console.log(`  ✓ ${name}`);
}

const NOW_ISO = '2026-11-26T09:00:00.000Z';

function plan(overrides = {}) {
  return {
    dayKey: '2026-11-26',
    headline: 'Hoy: Física 25 min y Lengua 20 min',
    availableMinutes: 120,
    plannedMinutes: 45,
    breakMinutes: 10,
    completedMinutes: 0,
    studiedMinutes: 0,
    energy: 'media',
    sessions: [
      {
        id: 'block-1',
        subjectId: 'subject-fisica',
        subjectName: 'Física',
        subjectColor: '#22d3ee',
        topicTitle: 'Campo gravitatorio',
        durationMinutes: 25,
        objective: 'Cerrar el fallo de signos',
        status: 'pendiente',
        isCompleted: false,
      },
      {
        id: 'block-2',
        subjectId: 'subject-lengua',
        subjectName: 'Lengua',
        subjectColor: '#f59e0b',
        topicTitle: 'Comentario de texto',
        durationMinutes: 20,
        objective: 'Practicar la tesis',
        status: 'completada',
        isCompleted: true,
      },
    ],
    dueReviews: 4,
    errorsOpen: 2,
    recovery: { active: false, headline: 'Primer día' },
    emptyReason: null,
    ...overrides,
  };
}

console.log('\n  Velocidad y DailyBrief\n');

console.log('  1) Contrato del brief');

ok('declara versión, origen de reglas y cero IA', () => {
  const brief = briefLib.buildDailyBrief(plan(), { generatedAtIso: NOW_ISO });
  assert.equal(brief.contractVersion, 1);
  assert.equal(brief.generatedBy, 'rules');
  assert.equal(brief.narration, null);
  assert.equal(brief.narrationStatus, 'skipped');
});

ok('convierte las sesiones en bloques pintables', () => {
  const brief = briefLib.buildDailyBrief(plan(), { generatedAtIso: NOW_ISO });
  assert.equal(brief.blocks.length, 2);
  assert.deepEqual(brief.blocks[0], {
    id: 'block-1',
    subjectId: 'subject-fisica',
    subjectName: 'Física',
    subjectColor: '#22d3ee',
    topicTitle: 'Campo gravitatorio',
    minutes: 25,
    objective: 'Cerrar el fallo de signos',
    status: 'pendiente',
    completed: false,
  });
  assert.equal(brief.blocks[1].completed, true);
  assert.match(brief.summary, /1 bloque pendiente/);
  assert.match(brief.summary, /45 min planificados/);
});

ok('es determinista para la misma foto', () => {
  const first = briefLib.buildDailyBrief(plan(), {
    generatedAtIso: NOW_ISO,
    nextExam: { title: 'Parcial', subjectName: 'Física', days: 2 },
  });
  const second = briefLib.buildDailyBrief(plan(), {
    generatedAtIso: NOW_ISO,
    nextExam: { title: 'Parcial', subjectName: 'Física', days: 2 },
  });
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

ok('mantiene el día, la energía y los minutos del plan', () => {
  const custom = plan({ dayKey: '2026-12-01', energy: 'alta', availableMinutes: 75 });
  const brief = briefLib.buildDailyBrief(custom, { generatedAtIso: NOW_ISO });
  assert.equal(brief.dayKey, '2026-12-01');
  assert.equal(brief.energy, 'alta');
  assert.equal(brief.availableMinutes, 75);
});

console.log('\n  2) Riesgos y próximo examen');

ok('un examen a 2 días es riesgo alto y se ve en el brief', () => {
  const brief = briefLib.buildDailyBrief(plan(), {
    generatedAtIso: NOW_ISO,
    nextExam: { title: 'Parcial de Física', subjectName: 'Física', days: 2 },
  });
  assert.deepEqual(brief.nextExam, {
    title: 'Parcial de Física',
    subjectName: 'Física',
    days: 2,
  });
  const exam = brief.risks.find((risk) => risk.code === 'exam');
  assert.ok(exam, 'falta el riesgo de examen');
  assert.equal(exam.severity, 'alta');
  assert.match(exam.title, /en 2 días/);
});

ok('un examen lejano no ensucia la apertura', () => {
  const brief = briefLib.buildDailyBrief(plan(), {
    generatedAtIso: NOW_ISO,
    nextExam: { title: 'Final', subjectName: 'Lengua', days: 20 },
  });
  assert.equal(brief.risks.some((risk) => risk.code === 'exam'), false);
});

ok('repasos y errores abiertos entran como riesgos accionables', () => {
  const brief = briefLib.buildDailyBrief(plan({ dueReviews: 12, errorsOpen: 7 }), {
    generatedAtIso: NOW_ISO,
  });
  const reviews = brief.risks.find((risk) => risk.code === 'reviews');
  const errors = brief.risks.find((risk) => risk.code === 'errors');
  assert.equal(reviews.severity, 'alta');
  assert.match(reviews.title, /12 repasos vencidos/);
  assert.equal(errors.severity, 'media');
});

ok('la vuelta tras días sin estudiar se explica sin dramatismo', () => {
  const brief = briefLib.buildDailyBrief(
    plan({ recovery: { active: true, headline: 'Vuelta tras 9 días' } }),
    { generatedAtIso: NOW_ISO }
  );
  const recovery = brief.risks.find((risk) => risk.code === 'recovery');
  assert.ok(recovery);
  assert.equal(recovery.title, 'Vuelta tras 9 días');
  assert.doesNotMatch(recovery.detail, /⚠️|fracaso|deuda imposible/);
});

ok('sin sesiones usa el motivo real del plan', () => {
  const brief = briefLib.buildDailyBrief(
    plan({ sessions: [], emptyReason: 'No queda tiempo útil hoy.', availableMinutes: 0 }),
    { generatedAtIso: NOW_ISO }
  );
  assert.equal(brief.blocks.length, 0);
  assert.equal(brief.summary, 'No queda tiempo útil hoy.');
  assert.equal(brief.risks.some((risk) => risk.code === 'empty'), false);
});

ok('el brief no filtra proveedor ni modelo', () => {
  const text = JSON.stringify(
    briefLib.buildDailyBrief(plan(), {
      generatedAtIso: NOW_ISO,
      nextExam: { title: 'Parcial', subjectName: 'Física', days: 1 },
    })
  );
  assert.doesNotMatch(text, /\b(gemini|groq|openrouter|nvidia|ollama|gpt|llama|qwen)\b/i);
});

console.log('\n  3) Materialización e invalidación');

ok('la clave del brief se congela por minuto', () => {
  const first = new Date('2026-11-26T09:00:01.000Z');
  const second = new Date('2026-11-26T09:00:59.000Z');
  const next = new Date('2026-11-26T09:01:00.000Z');
  assert.equal(briefLib.dailyBriefBucket(first), briefLib.dailyBriefBucket(second));
  assert.notEqual(briefLib.dailyBriefBucket(first), briefLib.dailyBriefBucket(next));
});

ok('la foto se guarda con unstable_cache y las etiquetas del plan', () => {
  const source = stripComments(read('src/lib/dailyBrief.ts'));
  assert.match(source, /unstable_cache/);
  assert.match(source, /tags:\s*\[\.\.\.PLAN_CACHE_TAGS\]/);
  assert.match(source, /revalidate:\s*60/);
  assert.match(source, /dayKey/);
  assert.match(source, /dailyBriefBucket|BUCKET_MS/);
});

ok('el plan compartido declara las tres etiquetas', () => {
  const source = stripComments(read('src/lib/planCache.ts'));
  for (const tag of ['daily-brief', 'cuartel', 'plan']) {
    assert.ok(source.includes(`'${tag}'`), `falta la etiqueta ${tag}`);
  }
});

ok('invalidatePlan purga la caché al cambiar el estado', () => {
  const source = stripComments(read('src/lib/planner/state.ts'));
  assert.match(source, /invalidatePlan[\s\S]*revalidatePlanCache\(\)/);
  assert.match(source, /setPlanEnergy[\s\S]*revalidatePlanCache\(\)/);
});

ok('el recálculo manual también purga', () => {
  const source = stripComments(read('src/lib/dayPlan.ts'));
  assert.match(source, /regenerateTodayPlan[\s\S]*revalidatePlanCache\(\)/);
});

ok('el planificador lee la revisión cacheada', () => {
  const source = stripComments(read('src/app/planificador/page.tsx'));
  assert.match(source, /getCachedDayReview/);
  assert.doesNotMatch(source, /reviewDayProgress\(/);
});

ok('el Cuartel lee el brief y no vuelve a llamar a ensureTodayPlan', () => {
  const source = stripComments(read('src/components/cuartel/DashboardWidgets.tsx'));
  assert.match(source, /getDailyBrief/);
  assert.doesNotMatch(source, /ensureTodayPlan/);
  assert.doesNotMatch(source, /readDayPlan/);
});

console.log('\n  4) Navegación y superficies');

ok('apuntes lee una foto cacheada y serializable', () => {
  const page = stripComments(read('src/app/apuntes/page.tsx'));
  const workspace = stripComments(read('src/lib/notesWorkspace.ts'));
  assert.match(page, /getNotesWorkspace/);
  assert.match(workspace, /unstable_cache/);
  assert.match(workspace, /tags:\s*\['apuntes', 'notas', 'moodle'\]/);
  assert.match(workspace, /updatedAtIso/);
});

ok('el hub de catedráticos lee un catálogo cacheado', () => {
  const page = stripComments(read('src/app/brainup/page.tsx'));
  const catalog = stripComments(read('src/lib/brainupCatalog.ts'));
  assert.match(page, /getBrainUpCatalog/);
  assert.match(catalog, /unstable_cache/);
  assert.match(catalog, /'catalogo'/);
});

ok('las páginas de lectura ya no fuerzan force-dynamic', () => {
  for (const file of [
    'src/app/page.tsx',
    'src/app/apuntes/page.tsx',
    'src/app/planificador/page.tsx',
    'src/app/brainup/page.tsx',
  ]) {
    assert.doesNotMatch(stripComments(read(file)), /force-dynamic/, `${file} sigue forzándolo`);
  }
});

ok('el layout conserva el modo dinámico para el build sin base', () => {
  const source = stripComments(read('src/app/layout.tsx'));
  assert.match(source, /export const dynamic = 'force-dynamic'/);
});

ok('las rutas de lectura siguen existiendo', () => {
  for (const file of [
    'src/app/page.tsx',
    'src/app/apuntes/page.tsx',
    'src/app/planificador/page.tsx',
    'src/app/brainup/page.tsx',
    'src/app/api/planner/route.ts',
  ]) {
    assert.ok(fs.existsSync(path.join(projectRoot, file)), `falta ${file}`);
  }
});

ok('las rutas de IA conservan su carácter dinámico', () => {
  const source = stripComments(read('src/app/api/tutor/route.ts'));
  assert.doesNotMatch(source, /force-dynamic/);
  assert.match(source, /export const maxDuration/);
});

ok('el script está registrado en package.json', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['verify:perf'], 'node scripts/verify-perf.js');
});

console.log(`\n  ${checks} comprobaciones en verde. DailyBrief listo y caché invalidable.\n`);
