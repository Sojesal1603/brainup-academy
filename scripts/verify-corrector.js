/**
 * Verificación del corrector con rúbrica y del banco de evaluación.
 *
 * No gasta ni una llamada de IA: comprueba las reglas que sí son deterministas
 * —esquema Zod, mediana, cuartos de punto, agregación del MAE— contra los
 * módulos puros. La corrección real con modelo se mide aparte, con
 * `npm run exam:mae` (banco de casos y error absoluto medio mostrado).
 *
 * Uso: node scripts/verify-corrector.js   (o npm run verify:corrector)
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const projectRoot = path.join(__dirname, '..');
const outDir = path.join(projectRoot, '.tmp-verify-corrector');

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
    path.join('src', 'lib', 'correctorRubric.ts'),
    path.join('src', 'lib', 'evalMetrics.ts'),
    '--outDir',
    '.tmp-verify-corrector',
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

const rubric = require(path.join(outDir, 'correctorRubric.js'));
const metrics = require(path.join(outDir, 'evalMetrics.js'));

console.log('\nRúbrica: esquema y mediana');
check('mediana de dos valores es su media', rubric.median([1, 2]) === 1.5, rubric.median([1, 2]));
check('mediana de tres valores es el central', rubric.median([3, 1, 2]) === 2);
check('mediana ignora valores no finitos', rubric.median([2, NaN, 1]) === 1.5);
check('mediana de vacío es 0, no NaN', rubric.median([]) === 0);

const validPass = {
  blocks: [{ index: 0, score: 1.5, feedback: 'Bien planteado, mal despejado.' }],
  weakTopicTitles: ['Sistemas'],
  globalFeedback: 'Nota final 6/10.',
};
check('una pasada válida pasa el esquema', rubric.rubricPassSchema.safeParse(validPass).success);
check(
  'acepta la coma decimal del modelo ("1,5")',
  rubric.rubricPassSchema.safeParse({
    ...validPass,
    blocks: [{ index: 0, score: '1,5', feedback: 'x' }],
  }).success
);
check(
  'rechaza una nota fuera de rango (11)',
  !rubric.rubricPassSchema.safeParse({
    ...validPass,
    blocks: [{ index: 0, score: 11, feedback: '' }],
  }).success
);
check(
  'rechaza una pasada sin bloques',
  !rubric.rubricPassSchema.safeParse({ blocks: [] }).success
);
check(
  'rechaza texto que no es JSON de rúbrica',
  rubric.looseJson('esto no es json') === null
);

const blocks = [
  { topicId: null, topicTitle: 'Álgebra', prompt: 'Resuelve el sistema.', points: 2.5 },
  { topicId: null, topicTitle: 'Análisis', prompt: 'Optimiza el área.', points: 2.5 },
];

console.log('\nDoble pasada: la mediana manda');
const combined = rubric.combinePasses({
  blocks,
  passes: [
    { blocks: [{ index: 0, score: 1, feedback: 'Corto.' }, { index: 1, score: 2, feedback: 'A' }], weakTopicTitles: ['Álgebra'], globalFeedback: 'Uno' },
    { blocks: [{ index: 0, score: 1.5, feedback: 'Explica el paso que falta y firma el resultado.' }, { index: 1, score: 2.5, feedback: 'B' }], weakTopicTitles: [], globalFeedback: 'Dos, más larga' },
  ],
});
check('bloque 1: mediana de 1 y 1,5 = 1,25', combined.blocks[0].score === 1.25, combined.blocks[0].score);
check('bloque 2: mediana de 2 y 2,5 = 2,25', combined.blocks[1].score === 2.25, combined.blocks[1].score);
check(
  'se queda el comentario más explicativo',
  combined.blocks[0].feedback.startsWith('Explica el paso')
);
check('los temas flojos se unen de todas las pasadas', combined.weakTopicTitles.includes('Álgebra'));
check('el total suma los bloques', combined.total === 3.5, combined.total);
check('se conservan las notas de cada pasada', combined.blocks[1].scores.length === 2);

const single = rubric.combinePasses({
  blocks,
  passes: [{ blocks: [{ index: 0, score: 2.5, feedback: 'Perfecto.' }], weakTopicTitles: [], globalFeedback: '' }],
});
check('con una sola pasada, esa nota manda (sin inventar la otra)', single.blocks[0].score === 2.5);
check('un bloque sin nota de ninguna pasada puntúa 0', single.blocks[1].score === 0, single.blocks[1].score);
check('el total no supera lo corregido', single.total === 2.5, single.total);

console.log('\nBanco de evaluación: error absoluto medio');
check(
  'MAE de errores 0 y 1 es 0,5',
  metrics.meanAbsoluteError([
    { expected: 2.5, got: 2.5 },
    { expected: 1, got: 2 },
  ]) === 0.5
);
check('MAE de vacío es 0', metrics.meanAbsoluteError([]) === 0);
check('MAE no se cancela con errores de signo opuesto', metrics.meanAbsoluteError([
  { expected: 1, got: 2 },
  { expected: 2, got: 1 },
]) === 1);

const summary = metrics.summarizeResults([
  { id: 'a', subject: 'Física', block: 'Campo', expectedScore: 2.5, gotScore: 2.5, absoluteError: 0 },
  { id: 'b', subject: 'Física', block: 'Campo', expectedScore: 1, gotScore: 2, absoluteError: 1 },
  { id: 'c', subject: 'Lengua', block: 'Comentario', expectedScore: 1.25, gotScore: 1, absoluteError: 0.25 },
]);
check('MAE global = 1,25/3 ≈ 0,42', summary.mae === 0.42, summary.mae);
check('MAE por materia: Física 0,5', summary.bySubject.find((g) => g.label === 'Física').mae === 0.5);
check('MAE por bloque: Comentario 0,25', summary.byBlock.find((g) => g.label === 'Comentario').mae === 0.25);
check('agrupa por materia y por bloque', summary.bySubject.length === 2 && summary.byBlock.length === 2);
check('cuenta los casos medidos', summary.cases === 3);

check(
  'el banco rechaza un caso con nota de referencia negativa',
  !metrics.evalCaseSchema.safeParse({
    id: 'x',
    subject: 'Física',
    block: 'Campo',
    topicTitle: 'Tema',
    prompt: 'Calcula el campo eléctrico entre dos cargas separadas 20 cm.',
    answer: 'E = kq/r²',
    expectedScore: -1,
  }).success
);
check(
  'el banco acepta un caso completo',
  metrics.evalCaseSchema.safeParse({
    id: 'x',
    subject: 'Física',
    block: 'Campo',
    topicTitle: 'Tema',
    prompt: 'Calcula el campo eléctrico entre dos cargas separadas 20 cm.',
    answer: 'E = kq/r²',
    expectedScore: 1.5,
  }).success
);
check('el banco de referencia tiene casos de más de una materia', new Set(metrics.EVAL_CASES.map((c) => c.subject)).size >= 2);

fs.rmSync(outDir, { recursive: true, force: true });

console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLO(S)`}`);
process.exit(failures === 0 ? 0 : 1);
