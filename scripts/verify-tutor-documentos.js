/**
 * Verificación de `src/lib/docContext.ts`: cómo se convierte un documento enorme
 * en algo que el catedrático pueda leer de verdad.
 *
 * Aquí es donde se prueba lo que hace posible subir un tema de 200 MB: el
 * documento **no** se le manda al modelo entero; se trocea una vez (al subirlo) y
 * en cada pregunta se le dan su mapa y los extractos que le tocan, con la página
 * delante para poder citarla. Como el módulo es **puro** (sin `fs`, sin Prisma y
 * sin red), se comprueba sin arrancar la app y sin gastar una sola llamada de IA.
 *
 * Lo que se comprueba, y por qué importa cada cosa:
 *
 *   1. **Troceado con páginas.** Un texto con marcas de página tiene que
 *      conservarlas: son lo que permite citar «en la página 213».
 *   2. **Rango de páginas por trozo.** Un trozo de 1 500 caracteres abarca varias
 *      páginas: pedir «la página 213» tiene que traer el trozo que la contiene
 *      aunque su etiqueta diga 212. Y el texto servido tiene que ser de verdad el
 *      de esa página.
 *   3. **Recuperación por relevancia.** Un dato enterrado en la página 4 000 de
 *      un documento de 6 000 páginas tiene que aparecer en el contexto de una
 *      pregunta que lo busque, sin que el contexto se salga del presupuesto.
 *   4. **Peticiones de páginas.** «Pásame las páginas 39 999-40 001» se traduce a
 *      números de verdad (y un número imposible se descarta sin romper nada).
 *   5. **Presupuesto.** Con varios documentos, ninguno se queda sin su mapa y
 *      entre todos no se pasa del tope de caracteres del turno.
 *
 * Uso: node scripts/verify-tutor-documentos.js
 */
const path = require('path');
const { execFileSync } = require('child_process');
const fs = require('fs');

const projectRoot = path.join(__dirname, '..');
const outDir = path.join(projectRoot, '.tmp-verify-tutor-documentos');

fs.rmSync(outDir, { recursive: true, force: true });

execFileSync(
  process.execPath,
  [
    require.resolve('typescript/bin/tsc'),
    path.join('src', 'lib', 'docContext.ts'),
    '--outDir',
    '.tmp-verify-tutor-documentos',
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

const docs = require(path.join(outDir, 'docContext.js'));

let failures = 0;
function check(label, condition, extra) {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.log(`  FALLO ${label}`, extra === undefined ? '' : extra);
  }
}

/**
 * Un documento largo como los de verdad: `pages` páginas con su marca, su título
 * y un párrafo, más un dato secreto escondido en una página concreta.
 */
function makeDocument(pages, secret) {
  const pieces = ['# Temario completo de la asignatura', ''];
  for (let page = 1; page <= pages; page += 1) {
    pieces.push(`--- Página ${page} ---`);
    pieces.push(`## Apartado ${page}`);
    pieces.push(
      `Explicación del apartado ${page} con su definición, su desarrollo y su error típico de examen.`.repeat(2)
    );
    pieces.push('');
    if (secret && page === secret.page) {
      pieces.push(`Dato de la página ${page}: el código es ${secret.code}.`);
      pieces.push('');
    }
  }
  return pieces.join('\n');
}

function main() {
  console.log('1) Troceado: las marcas de página se conservan');
  const short = docs.chunkDocument(
    ['--- Página 1 ---', 'Primer párrafo de la página uno.', '', '--- Página 2 ---', 'Primer párrafo de la página dos.'].join(
      '\n'
    )
  );
  check('un documento corto produce trozos', short.length > 0, `${short.length} trozos`);
  check(
    'cada trozo sabe de qué página sale',
    short.every((chunk) => typeof chunk.page === 'number'),
    JSON.stringify(short.map((c) => c.page))
  );
  check('la primera página es la 1', short[0].page === 1);
  check(
    'la etiqueta del trozo es su título',
    short[0].label === 'Primer párrafo de la página uno.' || short[0].label.includes('página uno'),
    JSON.stringify(short[0].label)
  );

  const plain = docs.chunkDocument('Texto sin ninguna marca de página, en un solo párrafo largo. '.repeat(30));
  check('sin marcas, la página es nula', plain.every((chunk) => chunk.page === null));
  check('sin marcas, el trozo sigue teniendo su rango vacío', plain.every((chunk) => chunk.pageFrom == null));
  check('un texto vacío no produce trozos', docs.chunkDocument('').length === 0);
  check(
    'ningún trozo se pasa del tope',
    plain.every((chunk) => chunk.text.length <= docs.CHUNK_MAX_CHARS),
    `${Math.max(...plain.map((c) => c.text.length))} caracteres`
  );

  console.log('\n2) Rango de páginas: un trozo abarca varias y lo dice');
  const secret = { page: 4000, code: 'TORTUGA-5521' };
  const book = docs.buildDocumentIndex({
    id: 'doc-libro',
    name: 'temario-completo.txt',
    text: makeDocument(6000, secret),
    pages: 6000,
    mode: 'texto',
  });

  check('el índice tiene el documento troceado', book.chunks.length > 100, `${book.chunks.length} trozos`);
  check('el título sale del primer título del texto', book.title.includes('Temario'), book.title);
  check(
    'todos los trozos declaran su rango de páginas',
    book.chunks.every((chunk) => typeof chunk.pageFrom === 'number' && typeof chunk.pageTo === 'number')
  );
  const widest = book.chunks.reduce(
    (most, chunk) => Math.max(most, (chunk.pageTo ?? 0) - (chunk.pageFrom ?? 0)),
    0
  );
  check('hay trozos que cubren más de una página', widest >= 1, `hasta ${widest + 1} páginas por trozo`);

  // La página pedida tiene que estar DENTRO del texto servido, no solo en el rango.
  let paginasBien = 0;
  const comprobadas = [1, 2, 213, 3999, 4000, 5999, 6000];
  for (const page of comprobadas) {
    const servido = docs.selectChunks(book, 'nada que ver con esto', {
      budgetChars: docs.DOC_CONTEXT_BUDGET_CHARS,
      pages: [page],
    });
    const cubre = servido.filter(
      (chunk) => (chunk.pageFrom ?? chunk.page) <= page && (chunk.pageTo ?? chunk.page) >= page
    );
    const texto = cubre.map((chunk) => chunk.text).join('\n');
    if (cubre.length > 0 && (texto.includes(`## Apartado ${page}`) || texto.includes(`--- Página ${page} ---`))) {
      paginasBien += 1;
    } else {
      console.log(`       (la página ${page} no ha llegado entera: ${cubre.length} trozos)`);
    }
  }
  check(
    'pedir una página trae su texto de verdad (no solo el número)',
    paginasBien === comprobadas.length,
    `${paginasBien} de ${comprobadas.length}`
  );

  console.log('\n3) Recuperación: un dato enterrado en la página 4000 aparece');
  const contexto = docs.buildDocumentContext([book], `¿Qué código aparece en la página ${secret.page}?`);
  check('el contexto trae el dato secreto', contexto.includes(secret.code));
  // El trozo cita el rango que cubre (puede empezar en la 3999 y llegar a la 4000),
  // así que la página del dato tiene que estar dentro de lo que dice.
  const citas = [...contexto.matchAll(/p[áa]gs?\. (\d+)(?:-(\d+))?/g)].map((m) => [
    Number(m[1]),
    Number(m[2] ?? m[1]),
  ]);
  check(
    'y cita la página de donde sale',
    citas.some(([from, to]) => secret.page >= from && secret.page <= to),
    citas.map(([from, to]) => `${from}-${to}`).join(' ')
  );
  check(
    'el contexto no se pasa del presupuesto',
    contexto.length <= docs.DOC_CONTEXT_BUDGET_CHARS + 2000,
    `${contexto.length} caracteres`
  );
  check('el contexto avisa de que hay más documento', /trozos; el resto/.test(contexto) || contexto.includes('pásame las páginas'));
  check(
    'lo que no está en el documento no se inventa: se dice',
    docs
      .buildDocumentContext([book], '¿Qué dice el protocolo ZZZ-9999-inexistente?')
      .includes('No he encontrado nada de esta pregunta')
  );
  check('sin documentos no hay bloque', docs.buildDocumentContext([], 'cualquier cosa') === '');
  check(
    'un presupuesto de cero no manda nada',
    docs.buildDocumentContext([book], 'algo', { budgetChars: 0 }) === ''
  );

  const repetido = docs.buildDocumentContext([book], `¿Qué código aparece en la página ${secret.page}?`);
  check('la misma pregunta da el mismo contexto (es determinista)', repetido === contexto);

  console.log('\n4) Peticiones de páginas: lo que pide el catedrático, en números');
  check(
    'un rango se convierte en sus páginas',
    docs
      .parsePageRequests('Necesito que me pases las páginas 39999-40001 del libro')
      .join(',') === '39999,40000,40001'
  );
  check('una lista con «y»', docs.parsePageRequests('páginas 12, 15 y 20').join(',') === '12,15,20');
  check('una sola página', docs.parsePageRequests('mírame la página 213').join(',') === '213');
  check('una página muy alta del libro', docs.parsePageRequests('página 70000').join(',') === '70000');
  check('un rango al revés se descarta', docs.parsePageRequests('páginas 90-40').length === 0);
  check('un número imposible se descarta', docs.parsePageRequests('página 99999999').length === 0);
  check('sin petición no hay páginas', docs.parsePageRequests('no te pido ninguna página').length === 0);
  check(
    'nunca se piden más páginas que el tope',
    docs.parsePageRequests('páginas 1-500').length === docs.MAX_PAGES_PER_REQUEST,
    `${docs.parsePageRequests('páginas 1-500').length}`
  );

  const pedidas = docs.parsePageRequests('pásame las páginas 3999-4001');
  const porPagina = docs.selectChunks(book, 'nada', {
    budgetChars: docs.DOC_CONTEXT_BUDGET_CHARS,
    pages: pedidas,
  });
  check(
    'las páginas pedidas se sirven aunque la pregunta no tenga nada que ver',
    porPagina.some((chunk) => chunk.text.includes(secret.code)),
    `${porPagina.length} trozos`
  );

  console.log('\n5) Varios documentos: todos tienen su mapa y el turno no se desborda');
  const otro = docs.buildDocumentIndex({
    id: 'doc-apuntes',
    name: 'apuntes-clase.md',
    text: ['# Apuntes de clase', '', '## Tema 1', 'La primera idea importante del tema uno.', '', '## Tema 2', 'La segunda idea del tema dos.'].join('\n'),
    pages: 0,
    mode: 'texto',
  });
  const varios = docs.buildDocumentContext([book, otro], 'Explícame el tema 2 de mis apuntes');
  check('los dos documentos salen en el bloque', varios.includes('temario-completo.txt') && varios.includes('apuntes-clase.md'));
  check('cada documento lleva su mapa', (varios.match(/MAPA \(/g) ?? []).length === 2);
  check(
    'entre todos no se pasa del presupuesto',
    varios.length <= docs.DOC_CONTEXT_BUDGET_CHARS + 4000,
    `${varios.length} caracteres`
  );
  const mapaLargo = docs.documentMap(book, 8);
  check('un documento enorme resume su mapa y dice cuántos quedan', /apartado\(s\) más/.test(mapaLargo), mapaLargo.slice(0, 120));
  const apartados = [...mapaLargo.matchAll(/p[áa]gs?\. \d+(?:-\d+)? ·/g)].length;
  check('el mapa con tope corto no se pasa de la cuenta', apartados <= 8, `${apartados} apartados`);
  check(
    'y los apartados salen repartidos por todo el documento, no solo del principio',
    mapaLargo.includes('pág. 6000') || mapaLargo.includes('págs. 59') || mapaLargo.includes('págs. 60'),
    mapaLargo.slice(-140)
  );
  check('un documento sin apartados devuelve su título', docs.documentMap(otro).length > 0);

  console.log(failures === 0 ? '\nTODO EN VERDE' : `\n${failures} COMPROBACIONES FALLIDAS`);
  fs.rmSync(outDir, { recursive: true, force: true });
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
