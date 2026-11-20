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
    '--outDir',
    '.tmp-verify-materias',
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

const C = require(path.join(outDir, 'category.js'));

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
/* Resultado                                                           */
/* ------------------------------------------------------------------ */

console.log('');
if (failures > 0) {
  console.log(`${failures} FALLO(S)`);
  process.exit(1);
}
console.log('TODO EN VERDE');
