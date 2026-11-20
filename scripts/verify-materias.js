/**
 * Verificación del Paso 14 (B7): categorías de materia, capas de prompt,
 * herramientas y modos.
 *
 * No gasta IA ni toca la base: compila los módulos puros con `tsc` y comprueba
 * la inferencia, la paridad de GENERAL, la migración expand-only, el backfill
 * y las guardas de integración.
 *
 * Uso: node scripts/verify-materias.js   (o npm run verify:materias)
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const projectRoot = path.join(__dirname, '..');
const outDir = path.join(projectRoot, '.tmp-verify-materias');

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
    path.join('src', 'lib', 'subjects', 'category.ts'),
    path.join('src', 'lib', 'subjects', 'modes.ts'),
    path.join('src', 'lib', 'studyTools.ts'),
    '--outDir',
    '.tmp-verify-materias',
    '--rootDir',
    path.join('src', 'lib'),
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

const C = require(path.join(outDir, 'subjects', 'category.js'));
const T = require(path.join(outDir, 'studyTools.js'));
const M = require(path.join(outDir, 'subjects', 'modes.js'));

/* ------------------------------------------------------------------ */
/* Inferencia                                                          */
/* ------------------------------------------------------------------ */

console.log('\nCategorías: una lista única, sin duplicar reglas por la app');

check('hay siete categorías', C.SUBJECT_CATEGORIES.length === 7, C.SUBJECT_CATEGORIES);
check(
  'todas tienen metadatos',
  C.SUBJECT_CATEGORIES.every((category) => Boolean(C.SUBJECT_CATEGORY_META[category]))
);

const cases = [
  ['Matemáticas', 'PROBLEMAS'],
  ['Física y Química', 'PROBLEMAS'],
  ['Estadística Aplicada', 'PROBLEMAS'],
  ['Biología y Geología', 'LABORATORIO'],
  ['Anatomía Humana', 'LABORATORIO'],
  ['Lengua Castellana y Literatura', 'COMENTARIO'],
  ['Historia de la Filosofía', 'COMENTARIO'],
  ['Historia del Arte', 'COMENTARIO'],
  ['Inglés', 'IDIOMA'],
  ['Francés', 'IDIOMA'],
  ['Latín', 'IDIOMA'],
  ['Música', 'EXPOSICION'],
  ['Educación Plástica', 'EXPOSICION'],
  ['Tecnología e Ingeniería I', 'TECNICA'],
  ['Informática', 'TECNICA'],
  ['Dibujo Técnico', 'TECNICA'],
  ['Orientación', 'GENERAL'],
  ['', 'GENERAL'],
];

for (const [name, expected] of cases) {
  check(`«${name || '(vacío)'}» → ${expected}`, C.inferSubjectCategory(name) === expected, C.inferSubjectCategory(name));
}

check(
  'la inferencia es estable',
  C.inferSubjectCategory('Física y Química') === C.inferSubjectCategory('Física y Química')
);
check('un valor inválido no pasa', C.normalizeSubjectCategory('CIENCIAS') === null);
check('un valor válido se conserva', C.normalizeSubjectCategory('LABORATORIO') === 'LABORATORIO');

check(
  'la categoría guardada manda sobre el nombre',
  C.subjectCategoryOf({ name: 'Matemáticas', category: 'COMENTARIO' }) === 'COMENTARIO'
);
check(
  'sin categoría se infiere',
  C.subjectCategoryOf({ name: 'Biología', category: null }) === 'LABORATORIO'
);
check(
  'una categoría corrupta cae a la inferencia',
  C.subjectCategoryOf({ name: 'Inglés', category: 'OTRA' }) === 'IDIOMA'
);

/* ------------------------------------------------------------------ */
/* Capas de prompt                                                     */
/* ------------------------------------------------------------------ */

console.log('\nPrompt: cada categoría declara su método y GENERAL no cambia nada');

check('GENERAL no añade capa', C.buildCategoryLayer('GENERAL').length === 0);

const markers = {
  PROBLEMAS: /unidades|comprobaci/i,
  LABORATORIO: /hipótesis|variables/i,
  COMENTARIO: /comillas|estructura/i,
  IDIOMA: /idioma|gramática/i,
  EXPOSICION: /guion|tesis/i,
  TECNICA: /código|diseño/i,
};

for (const [category, pattern] of Object.entries(markers)) {
  const layer = C.buildCategoryLayer(category).join(' ');
  check(`${category} declara su método`, pattern.test(layer), layer.slice(0, 80));
  check(`${category} no habla de PAU`, !/PAU|EBAU|nota de corte/i.test(layer));
}

const layers = C.SUBJECT_CATEGORIES.filter((category) => category !== 'GENERAL').map(
  (category) => C.buildCategoryLayer(category).join(' ')
);
check('cada categoría tiene una capa distinta', new Set(layers).size === layers.length);

/* ------------------------------------------------------------------ */
/* Herramientas por categoría                                          */
/* ------------------------------------------------------------------ */

console.log('\nHerramientas: la categoría ordena, no encierra');

check(
  'todas las categorías tienen herramientas',
  C.SUBJECT_CATEGORIES.every((category) => C.SUBJECT_CATEGORY_META[category].tools.length > 0)
);
check(
  'GENERAL conserva las cuatro de siempre',
  C.SUBJECT_CATEGORY_META.GENERAL.tools.join(',') === 'flashcards,test,mapa,guia'
);
check('PROBLEMAS empieza por problemas', C.SUBJECT_CATEGORY_META.PROBLEMAS.tools[0] === 'problemas');
check('LABORATORIO empieza por laboratorio', C.SUBJECT_CATEGORY_META.LABORATORIO.tools[0] === 'laboratorio');
check('COMENTARIO empieza por comentario', C.SUBJECT_CATEGORY_META.COMENTARIO.tools[0] === 'comentario');
check('IDIOMA empieza por idioma', C.SUBJECT_CATEGORY_META.IDIOMA.tools[0] === 'idioma');
check('una herramienta base sigue disponible', C.categorySupportsTool('COMENTARIO', 'test'));

/* ------------------------------------------------------------------ */
/* Modos de trabajo                                                    */
/* ------------------------------------------------------------------ */

console.log('\nModos: eje ortogonal, sin modo no cambia nada');

check('hay cinco modos', M.SUBJECT_MODES.length === 5, M.SUBJECT_MODES);
check(
  'todos tienen metadatos',
  M.SUBJECT_MODES.every((mode) => Boolean(M.SUBJECT_MODE_META[mode]))
);
check('sin modo no hay capa', M.buildModeLayer(null).length === 0);
check('un modo inválido no pasa', M.normalizeSubjectMode('ESTUDIAR') === null);
check('un modo válido se conserva', M.normalizeSubjectMode('simulacro') === 'SIMULACRO');

const modeMarkers = {
  DIAGNOSTICAR: /diagnostic/i,
  ENTRENAR: /practica/i,
  SIMULACRO: /examen real|sin ayudas/i,
  CORREGIR: /rúbrica/i,
  PREPARAR: /plan|sesiones/i,
};

for (const [mode, pattern] of Object.entries(modeMarkers)) {
  const layer = M.buildModeLayer(mode).join(' ');
  check(`${mode} declara su trabajo`, pattern.test(layer), layer.slice(0, 80));
  check(`${mode} no habla de PAU`, !/PAU|EBAU|nota de corte/i.test(layer));
}

const modeLayers = M.SUBJECT_MODES.map((mode) => M.buildModeLayer(mode).join(' '));
check('cada modo tiene una capa distinta', new Set(modeLayers).size === modeLayers.length);

/* ------------------------------------------------------------------ */
/* Herramientas de estudio: orden y lenguaje                          */
/* ------------------------------------------------------------------ */

console.log('\nHerramientas de estudio: el orden sigue a la categoría y el examen no se inventa');

check(
  'GENERAL conserva sus cuatro primeras',
  T.studyToolOrder('GENERAL').slice(0, 4).join(',') === 'flashcards,test,mapa,guia',
  T.studyToolOrder('GENERAL')
);
check(
  'EXPOSICION empieza por la guía',
  T.studyToolOrder('EXPOSICION')[0] === 'guia',
  T.studyToolOrder('EXPOSICION')
);
check(
  'ninguna herramienta desaparece del panel',
  T.studyToolOrder('IDIOMA').length === T.STUDY_TOOL_KINDS.length &&
    T.STUDY_TOOL_KINDS.every((kind) => T.studyToolOrder('IDIOMA').includes(kind))
);

const generalPrompt = T.buildStudyToolPrompt({
  kind: 'test',
  agentName: 'Catedrático',
  specialty: 'Profesor',
  subjectName: 'Orientación',
  studentName: 'Alumno',
  topic: { title: 'Unidad', unitNumber: 1 },
  focus: null,
}).system;
const comentarioPrompt = T.buildStudyToolPrompt({
  kind: 'test',
  agentName: 'Catedrático',
  specialty: 'Profesor',
  subjectName: 'Historia del Arte',
  category: 'COMENTARIO',
  studentName: 'Alumno',
  topic: { title: 'Unidad', unitNumber: 1 },
  focus: null,
}).system;

check('el test no promete EBAU por defecto', !/EBAU|PAU/i.test(generalPrompt));
check(
  'COMENTARIO pide análisis de fragmento',
  /análisis de un fragmento/.test(comentarioPrompt) && !/cálculo/.test(comentarioPrompt)
);
check(
  'el panel recibe la categoría y usa el orden',
  /studyToolOrder/.test(fs.readFileSync(path.join(projectRoot, 'src', 'components', 'brainup', 'StudyToolPanel.tsx'), 'utf8'))
);
check(
  'la ruta de herramientas pasa la categoría',
  /category:\s*agent\.subject\.category/.test(fs.readFileSync(path.join(projectRoot, 'src', 'app', 'api', 'tutor', 'tools', 'route.ts'), 'utf8'))
);
check(
  'las herramientas no hablan de etapa por su cuenta',
  !/\b(Bachillerato|ESO|EBAU)\b/.test(fs.readFileSync(path.join(projectRoot, 'src', 'lib', 'studyTools.ts'), 'utf8'))
);

/* ------------------------------------------------------------------ */
/* Herramientas nucleares                                             */
/* ------------------------------------------------------------------ */

console.log('\nHerramientas nucleares: parseo estricto y categoría que las pone primero');

const problems = T.parseStudyToolPayload(
  'problemas',
  JSON.stringify({
    title: 'Problema',
    statement: 'Un coche acelera…',
    steps: [
      { title: 'Datos', body: 'v0 = 0, a = 2 m/s²' },
      { title: 'Cálculo', body: 's = ½at² = 100 m' },
    ],
    solution: 's = 100 m',
  })
);
check('problemas parsea pasos y solución', problems && problems.kind === 'problemas' && problems.steps.length === 2);
check(
  'problemas sin solución se descarta',
  T.parseStudyToolPayload('problemas', JSON.stringify({ statement: 'x', steps: [{ title: 'a', body: 'b' }] })) === null
);

const lab = T.parseStudyToolPayload(
  'laboratorio',
  JSON.stringify({
    hypothesis: 'La masa no cambia el periodo',
    variables: { independent: 'masa', dependent: 'periodo', controlled: ['longitud'] },
    procedure: ['Montar', 'Medir', 'Repetir'],
    materials: ['Péndulo'],
    dataTable: { headers: ['m', 'T'], rows: [['0,1', '1,2']] },
    analysis: 'Constante',
    conclusion: 'Se cumple',
  })
);
check('laboratorio parsea variables y tabla', lab && lab.kind === 'laboratorio' && lab.dataTable?.rows.length === 1);
check(
  'laboratorio sin conclusión se descarta',
  T.parseStudyToolPayload('laboratorio', JSON.stringify({ hypothesis: 'x', procedure: ['a', 'b', 'c'] })) === null
);

const commentary = T.parseStudyToolPayload(
  'comentario',
  JSON.stringify({
    fragment: 'Texto',
    sections: [
      { heading: 'Localización', content: 'Siglo XIX' },
      { heading: 'Estructura', content: 'Dos partes' },
    ],
    conclusion: 'Intención crítica',
  })
);
check(
  'comentario parsea secciones',
  commentary && commentary.kind === 'comentario' && commentary.sections.length === 2
);
check(
  'comentario sin pruebas no pasa',
  T.parseStudyToolPayload('comentario', JSON.stringify({ sections: [{ heading: 'x', content: 'y' }], conclusion: 'z' })) === null
);

const language = T.parseStudyToolPayload(
  'idioma',
  JSON.stringify({
    task: 'Escribe una carta',
    modelAnswer: 'Dear…',
    corrections: [{ original: 'I has', corrected: 'I have', type: 'verbo', explanation: 'Concordancia' }],
    vocabulary: [{ term: 'however', meaning: 'sin embargo', example: 'However, …' }],
    practice: ['Completa: She ___ (go)'],
  })
);
check('idioma parsea correcciones', language && language.kind === 'idioma' && language.corrections.length === 1);
check(
  'idioma sin tarea no pasa',
  T.parseStudyToolPayload('idioma', JSON.stringify({ modelAnswer: 'x' })) === null
);

check('PROBLEMAS pone el problema primero', T.studyToolOrder('PROBLEMAS')[0] === 'problemas');
check('LABORATORIO pone la práctica primero', T.studyToolOrder('LABORATORIO')[0] === 'laboratorio');
check('COMENTARIO pone el comentario primero', T.studyToolOrder('COMENTARIO')[0] === 'comentario');
check('IDIOMA pone la práctica de idioma primero', T.studyToolOrder('IDIOMA')[0] === 'idioma');
check('TECNICA reutiliza problemas', T.studyToolOrder('TECNICA')[0] === 'problemas');

const toolsSource = fs.readFileSync(path.join(projectRoot, 'src', 'lib', 'studyTools.ts'), 'utf8');
const toolsRoute = fs.readFileSync(
  path.join(projectRoot, 'src', 'app', 'api', 'tutor', 'tools', 'route.ts'),
  'utf8'
);
check('idioma es text-only (sin audio)', /sin audio/i.test(toolsSource) && !/grabar|pronunciación con voz/i.test(toolsSource));
check('el lienzo avisa de que no ejecuta', /sin ejecutar el código/i.test(toolsSource));
check('la ruta verifica los problemas', /verifyBlock\(/.test(toolsRoute) && /tool\.verification\s*=/.test(toolsRoute));

/* ------------------------------------------------------------------ */
/* Esquema y migración                                                 */
/* ------------------------------------------------------------------ */

console.log('\nEsquema: columna nullable y migración expand-only');

const schema = fs.readFileSync(path.join(projectRoot, 'prisma', 'schema.prisma'), 'utf8');
const migration = fs.readFileSync(
  path.join(projectRoot, 'prisma', 'migrations', '20261120160000_subject_category', 'migration.sql'),
  'utf8'
);
const backfill = fs.readFileSync(
  path.join(projectRoot, 'scripts', 'backfill-subject-category.js'),
  'utf8'
);

check('el enum existe', /enum SubjectCategory \{/.test(schema));
check('la columna es nullable', /category\s+SubjectCategory\?/.test(schema));
check('la migración crea el tipo', /CREATE TYPE "SubjectCategory"/.test(migration));
check('la migración añade la columna', /ADD COLUMN "category"/.test(migration));
check(
  'la migración no destruye nada',
  !/\b(DROP|RENAME|MODIFY|ALTER COLUMN)\b/i.test(migration)
);
check('el backfill simula por defecto', /if \(!apply\)/.test(backfill));
check('el backfill solo rellena null', /category === null/.test(backfill));
check('el backfill no pisa decisiones', !/updateMany\(\{[\s\S]*category:/.test(backfill));

/* ------------------------------------------------------------------ */
/* Integración                                                         */
/* ------------------------------------------------------------------ */

console.log('\nIntegración: el prompt, la creación y los ajustes usan la categoría');

const read = (...parts) => fs.readFileSync(path.join(projectRoot, ...parts), 'utf8');
const tutor = read('src', 'lib', 'tutor.ts');
const tutorRoute = read('src', 'app', 'api', 'tutor', 'route.ts');
const agentPage = read('src', 'app', 'brainup', '[agentId]', 'page.tsx');
const chat = read('src', 'components', 'brainup', 'TutorChat.tsx');
const actions = read('src', 'lib', 'actions.ts');
const notion = read('src', 'components', 'apuntes', 'NotionWorkspace.tsx');
const ajustes = read('src', 'app', 'ajustes', 'page.tsx');
const panel = read('src', 'components', 'ajustes', 'SubjectCategoriesPanel.tsx');

check('el prompt importa la capa', /buildCategoryLayer/.test(tutor) && /subjectCategoryOf/.test(tutor));
check(
  'la capa entra tras la de materia',
  tutor.search(/buildSubjectLayer\(/) >= 0 &&
    tutor.search(/buildSubjectLayer\(/) < tutor.search(/buildCategoryLayer\(/)
);
check('la ruta pasa la categoría al prompt', /category:\s*agent\.subject\.category/.test(tutorRoute));
check('la página pasa la categoría al chat', /category:\s*agent\.subject\.category/.test(agentPage));
check(
  'el chat tipa la categoría',
  /category:\s*(string|SubjectCategory)\s*\|\s*null/.test(chat)
);
check(
  'crear materia guarda categoría explícita o inferida',
  /normalizeSubjectCategory\(data\.category\)\s*\?\?\s*inferSubjectCategory\(data\.name\)/.test(actions)
);
check('el formulario deja elegir categoría', /newSubjectForm.category/.test(notion) && /AUTO/.test(notion));
check('Ajustes muestra el panel', /SubjectCategoriesPanel/.test(ajustes));
check('el panel escribe con la acción', /setSubjectCategory/.test(panel));
check('el prompt añade la capa de modo', /buildModeLayer\(ctx\.mode\)/.test(tutor));
check(
  'el modo entra tras la categoría',
  tutor.search(/buildCategoryLayer\(/) < tutor.search(/buildModeLayer\(ctx\.mode\)/)
);
check('la ruta normaliza el modo', /normalizeSubjectMode\(body\.mode\)/.test(tutorRoute));
check('la ruta pasa el modo al contexto', /\bmode,\s+measuredTopics/.test(tutorRoute));
check('el chat envía el modo', /shareNotes,\s*mode,/.test(chat));
check('el chat deja elegir el modo', /SUBJECT_MODES\.map/.test(chat));
check(
  'la página acepta ?mode=',
  /searchParams/.test(agentPage) && /normalizeSubjectMode\(/.test(agentPage) && /initialMode=/.test(agentPage)
);
check(
  'el hub ofrece entrar en un modo',
  /ModeShortcuts/.test(read('src', 'app', 'brainup', 'page.tsx')) &&
    /\?mode=/.test(read('src', 'components', 'brainup', 'ModeShortcuts.tsx'))
);

check(
  'las materias creadas por curso se infieren igual',
  /category:\s*inferSubjectCategory/.test(read('src', 'lib', 'courseApply.ts')) &&
    /category:\s*inferSubjectCategory/.test(read('src', 'lib', 'setupApply.ts'))
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
