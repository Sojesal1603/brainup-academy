/**
 * Verificación de `src/lib/tutorNotes.ts`: qué apuntes del alumno entran en el
 * prompt del catedrático y con cuánto texto.
 *
 * Es un módulo puro (sin Prisma ni red), así que aquí se comprueba de verdad, sin
 * gastar API: el extracto limpia el markdown, el corte es por palabra, los
 * apuntes fijados van primero, nunca pasan de seis y el presupuesto total de
 * caracteres se respeta. Ese tope es lo que impide que el cuaderno entero viaje
 * en cada mensaje.
 *
 * Uso: node scripts/verify-tutor-contexto.js
 */
const path = require('path');
const { execFileSync } = require('child_process');
const fs = require('fs');

const projectRoot = path.join(__dirname, '..');
const outDir = path.join(projectRoot, '.tmp-verify-tutor-contexto');

fs.rmSync(outDir, { recursive: true, force: true });

execFileSync(
  process.execPath,
  [
    require.resolve('typescript/bin/tsc'),
    path.join('src', 'lib', 'tutorNotes.ts'),
    '--outDir',
    '.tmp-verify-tutor-contexto',
    '--module',
    'commonjs',
    '--target',
    'es2022',
    '--moduleResolution',
    'node',
    '--skipLibCheck',
  ],
  { cwd: projectRoot, stdio: 'inherit' }
);

const notes = require(path.join(outDir, 'tutorNotes.js'));

let failures = 0;
function check(label, condition, extra) {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.log(`  FALLO ${label}`, extra === undefined ? '' : extra);
  }
}

/** Fila de apunte como la que entrega la ruta del tutor. */
function row(overrides) {
  return {
    id: overrides.id ?? 'n1',
    title: overrides.title ?? 'Apunte',
    content: overrides.content ?? 'Contenido',
    tags: null,
    isPinned: overrides.isPinned ?? false,
    updatedAt: overrides.updatedAt ?? new Date('2026-10-01T10:00:00Z'),
    topicTitle: overrides.topicTitle ?? null,
    unitNumber: overrides.unitNumber ?? null,
  };
}

function main() {
  console.log('1) Extracto de un apunte: limpia el markdown y corta por palabra');
  const messy = [
    '# Tema 3',
    '',
    'Regla: **primero** paso todo a unidades.',
    '```js',
    'const x = 1;',
    '```',
    'Ver [la teoría](https://ejemplo.com) y ![figura](foto.png).',
    '> Error típico: olvidar el cambio de unidades.',
  ].join('\n');

  const excerpt = notes.noteExcerpt(messy, 500);
  check('no quedan vallas de código', !excerpt.includes('```'));
  check('no queda markdown de negrita ni de título', !excerpt.includes('**') && !excerpt.includes('#'));
  check('el enlace conserva su texto, sin la URL', excerpt.includes('la teoría') && !excerpt.includes('https://'));
  check('no queda la imagen ni su ruta', !excerpt.includes('foto.png'));
  check('sin saltos de línea ni espacios de más', !/\s{2,}/.test(excerpt) && !excerpt.includes('\n'));
  check('conserva el contenido útil', excerpt.includes('Error típico'), excerpt.slice(0, 90));

  const long = 'palabra '.repeat(400);
  const cut = notes.noteExcerpt(long, 100);
  // El límite es un tope duro: el «…» cuenta dentro de él.
  check(
    'corta por palabra y avisa con puntos suspensivos, sin pasar del límite',
    cut.endsWith('…') && cut.length <= 100,
    `${cut.length} caracteres`
  );
  const body = cut.slice(0, -1);
  const at = long.indexOf(body);
  check(
    'el corte cae en el final de una palabra (no la parte)',
    at >= 0 && (at + body.length >= long.length || long[at + body.length] === ' '),
    JSON.stringify(cut.slice(-24))
  );

  check('un apunte vacío no produce extracto', notes.noteExcerpt('   \n\n  ') === '');
  check('el límite por defecto es el documentado', notes.MAX_NOTE_EXCERPT_CHARS === 500);
  check('el presupuesto total está acotado', notes.MAX_TOTAL_NOTES_CHARS === 2400);
  check('nunca se mandan más de seis apuntes', notes.MAX_SHARED_NOTES === 6);

  console.log('\n2) Selección: fijados primero, después los recientes');
  const ordered = notes.selectNotesForTutor([
    row({ id: 'a', title: 'Antiguo', updatedAt: new Date('2026-09-01T10:00:00Z') }),
    row({ id: 'b', title: 'Fijado', isPinned: true, updatedAt: new Date('2026-08-01T10:00:00Z') }),
    row({ id: 'c', title: 'Reciente', updatedAt: new Date('2026-10-10T10:00:00Z') }),
  ]);
  check('el fijado va el primero', ordered[0].title === 'Fijado', ordered.map((n) => n.title).join(' → '));
  check('después, el más reciente', ordered[1].title === 'Reciente');
  check('y por último el más antiguo', ordered[2].title === 'Antiguo');

  console.log('\n3) Límites: seis apuntes como mucho y presupuesto de caracteres');
  const many = notes.selectNotesForTutor(
    Array.from({ length: 9 }, (_, index) =>
      row({ id: `m${index}`, title: `Apunte ${index}`, content: 'texto corto', updatedAt: new Date(2026, 9, index + 1) })
    )
  );
  check('se queda en seis', many.length === 6, `${many.length} apuntes`);

  const heavy = notes.selectNotesForTutor(
    Array.from({ length: 9 }, (_, index) =>    row({ id: `h${index}`, title: `Largo ${index}`, content: 'texto '.repeat(100) }))
  );
  const totalChars = heavy.reduce((sum, note) => sum + note.excerpt.length, 0);
  check(
    'el total de extractos nunca pasa del presupuesto',
    totalChars <= notes.MAX_TOTAL_NOTES_CHARS,
    `${totalChars} caracteres en ${heavy.length} apuntes`
  );
  check('y por eso no entran los nueve', heavy.length < 9, `${heavy.length} apuntes`);

  const emptyOnes = notes.selectNotesForTutor([
    row({ id: 'e1', content: '' }),
    row({ id: 'e2', content: '   ' }),
    row({ id: 'e3', title: 'Válido', content: 'algo' }),
  ]);
  check('los apuntes vacíos no se mandan', emptyOnes.length === 1 && emptyOnes[0].title === 'Válido');
  check('una lista vacía devuelve vacío', notes.selectNotesForTutor([]).length === 0);

  console.log('\n4) La unidad del apunte viaja con él para poder citarla');
  check(
    'con unidad y título',
    notes.noteTopicLabel({ topicTitle: 'Matrices', unitNumber: 3 }) === 'U3 · Matrices'
  );
  check('sin número de unidad', notes.noteTopicLabel({ topicTitle: 'Matrices', unitNumber: null }) === 'Matrices');
  check('sin unidad no hay etiqueta', notes.noteTopicLabel({ topicTitle: null, unitNumber: null }) === null);
  check(
    'el apunte lleva su etiqueta de unidad al prompt',
    notes.selectNotesForTutor([row({ topicTitle: 'Matrices', unitNumber: 3 })])[0].topicLabel === 'U3 · Matrices'
  );
  check(
    'un apunte sin título no queda sin nombre',
    notes.selectNotesForTutor([row({ title: '   ' })])[0].title === 'Sin título'
  );

  console.log(failures === 0 ? '\nTODO EN VERDE' : `\n${failures} COMPROBACIONES FALLIDAS`);
  fs.rmSync(outDir, { recursive: true, force: true });
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
