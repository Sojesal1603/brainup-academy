/**
 * Verificación de etapas, backfill y pedagogía activa (Paso 11).
 *
 * No gasta IA ni escribe en la base: compila los módulos puros de
 * `src/lib/stages` y comprueba las reglas que sostienen ESO, Bachillerato y
 * Universidad. Además vigila dos cosas que podrían romper producción:
 *   1. que la migración siga siendo expand-only;
 *   2. que los condicionales por etapa no se hayan dispersado por la app.
 *
 * Uso: node scripts/verify-stages.js   (o npm run verify:stages)
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const projectRoot = path.join(__dirname, '..');
const outDir = path.join(projectRoot, '.tmp-verify-stages');

let failures = 0;
function check(label, condition, extra) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FALLO ${label}`, extra === undefined ? '' : extra);
  }
}

console.log('Catálogo de etapas');
fs.rmSync(outDir, { recursive: true, force: true });
execFileSync(
  process.execPath,
  [
    require.resolve('typescript/bin/tsc'),
    path.join('src', 'lib', 'stages', 'index.ts'),
    '--outDir',
    '.tmp-verify-stages',
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

const stages = require(path.join(outDir, 'index.js'));
const { catalog } = {
  catalog: require(path.join(outDir, 'catalog.js')),
};

// ---------------------------------------------------------------- inferencia
const eso1 = catalog.inferStageFromModality('1º ESO');
check('1º ESO → ESO', eso1.stage === 'ESO' && eso1.gradeLevel === '1º ESO', eso1);
const eso4 = catalog.inferStageFromModality('4º de ESO');
check('4º de ESO → ESO/4º', eso4.stage === 'ESO' && eso4.gradeLevel === '4º ESO', eso4);

const bach2 = catalog.inferStageFromModality(
  '2º de Bachillerato (Ciencias y Tecnología)'
);
check(
  '2º Bachillerato (Ciencias) → BACH/c2/ciencias',
  bach2.stage === 'BACHILLERATO' && bach2.gradeLevel === '2º Bachillerato' && bach2.trackKey === 'ciencias',
  bach2
);
const bachHum = catalog.inferStageFromModality(
  '1º de Bachillerato (Humanidades y Ciencias Sociales)'
);
check('Humanidades → track humanidades', bachHum.trackKey === 'humanidades', bachHum);

const uni = catalog.inferStageFromModality(
  'Universidad · Grado en Ingeniería Mecánica (Ingeniería y Arquitectura) · 3º curso'
);
check(
  'Universidad → UNI/3º/ingeniería/titulación',
  uni.stage === 'UNIVERSIDAD' &&
    uni.gradeLevel === '3º curso' &&
    uni.trackKey === 'ingenieria' &&
    uni.degreeName === 'Grado en Ingeniería Mecánica',
  uni
);

const unknown = catalog.inferStageFromModality('FP Básica de Cocina');
check(
  'modalidad desconocida → Bachillerato sin inventar curso en Ajustes',
  unknown.stage === 'BACHILLERATO' && catalog.isRecognizedModality('FP Básica de Cocina') === false,
  unknown
);

// ------------------------------------------------------------ configuraciones
const eso = stages.getStageConfig({ modality: '3º ESO' });
const bach = stages.getStageConfig({ modality: '2º de Bachillerato' });
const grado = stages.getStageConfig({
  modality: 'Universidad · Grado en Medicina (Ciencias de la Salud) · 1º curso',
});
check('ESO: escala /10 y sin PAU', eso.scale.max === 10 && eso.scale.hasPau === false);
check('Bachillerato: escala /14 y PAU', bach.scale.max === 14 && bach.scale.hasPau === true);
check('Universidad: sin PAU y con ECTS', grado.scale.hasPau === false && grado.supportsEcts === true);
check('Universidad: convocatorias soportadas', grado.supportsConvocatorias === true);
check('ESO: 4 cursos', eso.gradeLevels.length === 4, eso.gradeLevels.map((level) => level.key));
check('Bachillerato: 2 cursos', bach.gradeLevels.length === 2);
check('Universidad: 5 cursos', grado.gradeLevels.length === 5);
check('Bachillerato: 3 modalidades oficiales', bach.tracks.length === 3);
check('Universidad: 5 ramas', grado.tracks.length === 5);
check('ESO oculta el Examinador PAU', eso.tools.hiddenHrefs.includes('/examinador'));
check('Universidad oculta el Examinador PAU', grado.tools.hiddenHrefs.includes('/examinador'));
check('Bachillerato conserva el Examinador PAU', !bach.tools.hiddenHrefs.includes('/examinador'));
check('ESO: cabecera LOMLOE sin 14', eso.headerChipKind === 'lomloe');
check('Bachillerato: cabecera PAU', bach.headerChipKind === 'pau');
check('Universidad: cabecera de curso', grado.headerChipKind === 'course');
check(
  'planificador dentro de las reglas del motor',
  [eso, bach, grado].every(
    (config) =>
      config.planner.capacityRatio === 0.7 &&
      config.planner.minBlockMin >= 10 &&
      config.planner.maxBlocks >= 3 &&
      config.planner.maxBlocks <= 5
  )
);

// ------------------------------------------------------------------ plantillas
const eso1Subjects = catalog.subjectTemplatesFor({ stage: 'ESO', gradeLevel: '1º ESO' });
check('1º ESO conserva sus 9 materias base', eso1Subjects.length === 9, eso1Subjects.length);
check(
  '1º ESO conserva los nombres que ya existían',
  eso1Subjects.some((subject) => subject.name === 'Matemáticas') &&
    eso1Subjects.some((subject) => subject.name === 'Educación Plástica')
);
const eso4Subjects = catalog.subjectTemplatesFor({ stage: 'ESO', gradeLevel: '4º ESO' });
check('4º ESO trae plantilla LOMLOE', eso4Subjects.length >= 8, eso4Subjects.length);
check(
  'Bachillerato no crea materias automáticamente',
  catalog.subjectTemplatesFor({ stage: 'BACHILLERATO', gradeLevel: '1º Bachillerato' }).length === 0
);
for (const track of grado.tracks) {
  const templates = catalog.subjectTemplatesFor({
    stage: 'UNIVERSIDAD',
    gradeLevel: '1º curso',
    trackKey: track.key,
  });
  check(
    `Universidad/${track.key}: 3–5 troncales con ECTS`,
    templates.length >= 3 && templates.length <= 5 && templates.every((subject) => subject.credits > 0),
    templates.length
  );
}

// --------------------------------------------------------------- normalización
const roundTrip = [
  { stage: 'ESO', gradeLevel: '2º ESO', trackKey: null, degreeName: null },
  { stage: 'BACHILLERATO', gradeLevel: '2º Bachillerato', trackKey: 'humanidades', degreeName: null },
  {
    stage: 'UNIVERSIDAD',
    gradeLevel: '4º curso',
    trackKey: 'artes',
    degreeName: 'Grado en Historia del Arte',
  },
];
for (const selection of roundTrip) {
  const normalized = catalog.normalizeStageSelection(selection);
  const parsed = catalog.inferStageFromModality(normalized.modality);
  check(
    `ida y vuelta ${selection.stage}/${selection.gradeLevel}`,
    parsed.stage === normalized.stage &&
      parsed.gradeLevel === normalized.gradeLevel &&
      parsed.trackKey === normalized.trackKey,
    { modality: normalized.modality, parsed }
  );
}
const uniTitle = catalog.normalizeStageSelection({
  stage: 'UNIVERSIDAD',
  gradeLevel: '2º curso',
  trackKey: 'ingenieria',
  degreeName: 'Ingeniería Mecánica',
});
const uniTitleParsed = catalog.inferStageFromModality(uniTitle.modality);
check(
  'la titulación se guarda completa y sin duplicar «Grado en»',
  uniTitleParsed.degreeName === 'Grado en Ingeniería Mecánica' &&
    (uniTitle.modality.match(/Grado en/g) ?? []).length === 1,
  { modality: uniTitle.modality, degreeName: uniTitleParsed.degreeName }
);
const uniTitleAgain = catalog.normalizeStageSelection({
  stage: 'UNIVERSIDAD',
  gradeLevel: '2º curso',
  trackKey: 'ingenieria',
  degreeName: uniTitleParsed.degreeName,
});
check(
  'la titulación es idempotente al reguardar',
  uniTitleAgain.modality === uniTitle.modality,
  [uniTitle.modality, uniTitleAgain.modality]
);

const fallback = catalog.normalizeStageSelection({
  stage: 'NO_EXISTE',
  gradeLevel: '99º',
  trackKey: 'nada',
  degreeName: '',
});
check(
  'etapa inválida cae a Bachillerato con curso válido',
  fallback.stage === 'BACHILLERATO' && fallback.gradeLevel === '1º Bachillerato',
  fallback
);
check(
  'inferencia idempotente',
  JSON.stringify(catalog.inferStageFromModality('1º ESO')) ===
    JSON.stringify(catalog.inferStageFromModality(catalog.inferStageFromModality('1º ESO').modality))
);

// ------------------------------------------------------------------- prompts
console.log('\nPrompts en capas');
const esoData = {
  stage: 'ESO',
  label: '1º ESO',
  curriculum: 'LOMLOE 1º ESO',
  scaleLabel: 'Nota /10',
  hasPau: false,
};
const bachData = {
  stage: 'BACHILLERATO',
  label: '2º Bachillerato',
  curriculum: 'Bachillerato (LOMLOE)',
  scaleLabel: 'PAU /14',
  hasPau: true,
};
const esoLines = stages.buildStagePromptLayer(esoData);
check(
  'paridad ESO: el texto es el que ya se enviaba',
  esoLines.length === 1 &&
    esoLines[0] ===
      'NIVEL PEDAGÓGICO: está en 1º ESO. Ajusta el vocabulario, los ejemplos, los prerrequisitos y la profundidad al currículo LOMLOE 1º ESO; nada de contenidos de Bachillerato, PAU ni notas sobre 14. Preparas las pruebas reales de su curso y su centro.',
  esoLines[0]
);
const bachLines = stages.buildStagePromptLayer(bachData);
check(
  'paridad Bachillerato: el texto es el que ya se enviaba',
  bachLines.length === 1 &&
    bachLines[0] === 'Preparando los exámenes reales de su curso y su centro.',
  bachLines[0]
);
const gradoLines = stages.buildStagePromptLayer({
  stage: 'UNIVERSIDAD',
  label: '2º curso',
  curriculum: 'Grado en Física · Ciencias · 2º curso',
  scaleLabel: 'Nota /10 · ECTS',
  hasPau: false,
});
check(
  'Universidad tiene capa propia (Grado/ECTS)',
  gradoLines.length === 1 && /Grado/.test(gradoLines[0]) && /ECTS/.test(gradoLines[0])
);
check('la base pedagógica no depende de la etapa', stages.BASE_PEDAGOGY_LAYER.length === 6);
check(
  'la capa de materia nombra la asignatura',
  JSON.stringify(stages.buildSubjectLayer('Física')) === JSON.stringify(['Asignatura: Física.'])
);
check(
  'puesta a punto: ESO conserva su línea exacta',
  stages.buildSetupStageLines({ ...esoData, targetPau: 13.5 })[0] ===
    'Está en 1º ESO: no hay PAU ni nota objetivo sobre 14. Ajusta el temario, el nivel y los exámenes al currículo LOMLOE 1º ESO.'
);
check(
  'puesta a punto: Bachillerato conserva su nota /14',
  stages.buildSetupStageLines({ ...bachData, targetPau: 12.5 })[0] === 'Nota PAU objetivo: 12.5/14.'
);

// ---------------------------------------------------------- pedagogía activa
console.log('\nPedagogía activa (determinista)');
const baseContext = {
  stage: 'BACHILLERATO',
  subjectName: 'Matemáticas II',
  pendingErrors: 0,
  weakUnits: 0,
  hasUpcomingExam: false,
  minutes: 45,
};
const first = stages.pickTechnique(baseContext);
const second = stages.pickTechnique({ ...baseContext });
check('mismas entradas → misma técnica', first.key === second.key, [first.key, second.key]);
check(
  'errores reales mandan: recuperación sobre errores',
  stages.pickTechnique({ ...baseContext, pendingErrors: 2 }).key === 'recuperacion_error'
);
check(
  'examen próximo en Bachillerato: práctica intercalada',
  stages.pickTechnique({ ...baseContext, hasUpcomingExam: true }).key === 'intercalada'
);
check(
  'unidades flojas en humanidades: Feynman',
  stages.pickTechnique({ ...baseContext, subjectName: 'Historia de España', weakUnits: 2 }).key ===
    'feynman'
);
check(
  'ESO sin señales: diálogo socrático',
  stages.pickTechnique({ ...baseContext, stage: 'ESO', subjectName: 'Matemáticas' }).key ===
    'socratica'
);
check(
  'idiomas usan práctica recuperativa',
  stages.pickTechnique({ ...baseContext, weakUnits: 1, subjectName: 'Inglés' }).key ===
    'practica_recuperativa'
);
check(
  'Universidad con cálculo: resolución guiada',
  stages.pickTechnique({ ...baseContext, stage: 'UNIVERSIDAD', subjectName: 'Cálculo I' }).key ===
    'resolucion_guiada'
);
const sequence = stages.pickTechniqueSequence({ ...baseContext, pendingErrors: 2 });
check('la secuencia no repite la misma técnica', new Set(sequence.map((item) => item.key)).size === sequence.length);
const activeLayer = stages.buildActivePedagogyLayer(baseContext);
check('la capa declara la técnica elegida', activeLayer.some((line) => line.includes(first.name)));
check('la capa fija la profundidad de la etapa', activeLayer.some((line) => line.includes('PROFUNDIDAD POR ETAPA')));
check('la capa deja preparado el cierre del Paso 10', activeLayer.some((line) => line.includes('CIERRE')));
check('la capa de ESO no habla de PAU', !stages.buildActivePedagogyLayer({ ...baseContext, stage: 'ESO' }).join(' ').includes('PAU'));

// ------------------------------------------------ guardas de producción
console.log('\nGuardas de producción');
const migration = fs.readFileSync(
  path.join(projectRoot, 'prisma', 'migrations', '20261120120000_education_stage', 'migration.sql'),
  'utf8'
);
check('migración: crea el enum EducationStage', /CREATE TYPE "EducationStage"/.test(migration));
for (const column of ['stage', 'gradeLevel', 'trackKey', 'degreeName']) {
  check(`migración: añade ${column}`, new RegExp(`ADD COLUMN "${column}"`).test(migration));
}
check(
  'migración expand-only: sin DROP/RENAME/MODIFY',
  !/\b(DROP|RENAME|MODIFY|ALTER COLUMN)\b/i.test(migration)
);

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}
const allowed = (file) => {
  const relative = path.relative(projectRoot, file).replace(/\\/g, '/');
  return (
    relative.startsWith('src/lib/stages/') ||
    relative === 'src/lib/courseCatalog.ts' ||
    relative === 'src/components/ajustes/StageSelector.tsx'
  );
};
const scattered = walk(path.join(projectRoot, 'src')).filter((file) => {
  if (allowed(file)) return false;
  const content = fs.readFileSync(file, 'utf8');
  return /(?:course\.)?stage\s*(?:===|!==)\s*'(?:ESO|BACHILLERATO|UNIVERSIDAD)'/.test(content);
});
check(
  'los condicionales por etapa viven solo en stages/ y courseCatalog.ts',
  scattered.length === 0,
  scattered.map((file) => path.relative(projectRoot, file))
);

const backfill = fs.readFileSync(
  path.join(projectRoot, 'scripts', 'backfill-education-stage.js'),
  'utf8'
);
check('backfill: simulación por defecto', /SIMULACIÓN: no se ha escrito nada/.test(backfill));
check('backfill: escritura solo con --apply', /--apply/.test(backfill) && /--limit=/.test(backfill));

fs.rmSync(outDir, { recursive: true, force: true });

console.log('');
if (failures > 0) {
  console.log(`FALLOS: ${failures}`);
  process.exit(1);
}
console.log('TODO EN VERDE');
