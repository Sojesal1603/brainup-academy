/**
 * Verificación del lienzo modular sin base de datos ni red.
 *
 *   · profundidad de bloques, ciclos y límite de ampliación;
 *   · lo editado por el alumno (y sus padres) no se borra al regenerar;
 *   · una sección solo está COMPLETED si tiene contenido;
 *   · las citas se clasifican como VERIFIED / UNVERIFIED / ERROR sin perdonar;
 *   · la proyección Markdown es determinista, omite lo omitido y no duplica
 *     saltos de línea.
 *
 * Uso: `npm run verify:lienzo`
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { compilaTs } = require('./lib/compilaTs');

const blocksDir = compilaTs('study/blocks', '.tmp-verify-lienzo-bloques');
const citationDir = compilaTs('study/citation', '.tmp-verify-lienzo-citas');
const projectionDir = compilaTs('study/projection', '.tmp-verify-lienzo-proyeccion');

const blocks = require(path.join(blocksDir, 'blocks.js'));
const citation = require(path.join(citationDir, 'citation.js'));
const projection = require(path.join(projectionDir, 'projection.js'));

let checks = 0;
function ok(name, fn) {
  fn();
  checks += 1;
  console.log(`  ✓ ${name}`);
}

/** Bloque mínimo completo, con todos los campos que exige BlockLike. */
function block(overrides = {}) {
  return {
    id: overrides.id ?? 'b1',
    parentId: overrides.parentId ?? null,
    order: overrides.order ?? 0,
    type: overrides.type ?? 'TEXT',
    content: overrides.content ?? 'Contenido',
    isEdited: overrides.isEdited ?? false,
    isAiGenerated: overrides.isAiGenerated ?? true,
    chunkId: overrides.chunkId ?? null,
    quote: overrides.quote ?? null,
    quoteStatus: overrides.quoteStatus ?? 'NONE',
  };
}

console.log('\n  Lienzo modular: bloques, citas y proyección\n');

ok('la raíz está a profundidad 0 y cada variante suma un nivel', () => {
  const root = block({ id: 'root' });
  const child = block({ id: 'child', parentId: 'root' });
  const grandchild = block({ id: 'grandchild', parentId: 'child' });
  const byId = new Map([root, child, grandchild].map((item) => [item.id, item]));

  assert.equal(blocks.blockDepth('root', byId), 0);
  assert.equal(blocks.blockDepth('child', byId), 1);
  assert.equal(blocks.blockDepth('grandchild', byId), 2);
});

ok('un ciclo corrupto no se puede medir ni ampliar', () => {
  const a = block({ id: 'a', parentId: 'b' });
  const b = block({ id: 'b', parentId: 'a' });
  const byId = new Map([
    [a.id, a],
    [b.id, b],
  ]);

  assert.equal(blocks.blockDepth('a', byId), Number.POSITIVE_INFINITY);
  assert.equal(blocks.canAddVariant('a', byId).ok, false);
});

ok('se permite ampliar dos niveles y se rechaza el tercero', () => {
  const root = block({ id: 'root' });
  const child = block({ id: 'child', parentId: 'root' });
  const grandchild = block({ id: 'grandchild', parentId: 'child' });
  const byId = new Map([root, child, grandchild].map((item) => [item.id, item]));

  assert.equal(blocks.canAddVariant('root', byId).ok, true);
  assert.equal(blocks.canAddVariant('child', byId).ok, true);
  assert.equal(blocks.canAddVariant('grandchild', byId).ok, false);
  assert.equal(blocks.canAddVariant('fantasma', byId).ok, false);
});

ok('un bloque editado arrastra a sus padres y ningún otro', () => {
  const root = block({ id: 'root' });
  const child = block({ id: 'child', parentId: 'root' });
  const edited = block({ id: 'edited', parentId: 'child', isEdited: true });
  const sibling = block({ id: 'sibling', parentId: 'root' });

  const keep = blocks.preservedBlockIds([root, child, edited, sibling]);
  assert.deepEqual([...keep].sort(), ['child', 'edited', 'root']);
});

ok('regenerar conserva lo editado y añade lo nuevo sin duplicar', () => {
  const edited = block({ id: 'a', order: 0, isEdited: true, content: 'Mío' });
  const plain = block({ id: 'b', order: 1, content: 'Viejo' });
  const generated = [
    block({ id: 'a', order: 0, content: 'Del modelo' }),
    block({ id: 'c', order: 1, content: 'Nuevo' }),
  ];

  const merged = blocks.mergeGeneratedBlocks([edited, plain], generated);
  assert.deepEqual(
    merged.kept.map((item) => item.id),
    ['a']
  );
  assert.deepEqual(
    merged.added.map((item) => item.id),
    ['c']
  );
  assert.equal(merged.discarded, 1);
  assert.equal(merged.kept[0].content, 'Mío');
});

ok('una generación vacía no borra el trabajo editado', () => {
  const edited = block({ id: 'a', isEdited: true });
  const merged = blocks.mergeGeneratedBlocks([edited], []);
  assert.equal(merged.kept.length, 1);
  assert.equal(merged.added.length, 0);
});

ok('COMPLETED exige contenido real, no un intento', () => {
  assert.equal(blocks.sectionStatusAfterExpansion([]), 'PENDING');
  assert.equal(blocks.sectionStatusAfterExpansion([block({ content: '   ' })]), 'PENDING');
  assert.equal(blocks.sectionStatusAfterExpansion([block({ content: 'Algo' })]), 'COMPLETED');
});

const allowed = new Map([
  [
    'chunk-1',
    {
      id: 'chunk-1',
      userId: 'u1',
      text: 'La energía cinética se define como un medio de la masa por la velocidad al cuadrado.',
    },
  ],
]);

ok('una cita literal del trozo permitido se verifica', () => {
  const result = citation.checkCitation({
    userId: 'u1',
    chunkId: 'chunk-1',
    quote: 'un medio de la masa por la velocidad al cuadrado',
    allowed,
  });
  assert.equal(result.status, 'VERIFIED');
  assert.equal(result.reason, null);
});

ok('una cita que no está en el trozo queda UNVERIFIED', () => {
  const result = citation.checkCitation({
    userId: 'u1',
    chunkId: 'chunk-1',
    quote: 'la energía cinética es igual a la masa por la gravedad',
    allowed,
  });
  assert.equal(result.status, 'UNVERIFIED');
  assert.ok(result.reason);
});

ok('sin chunkId, con chunk ajeno o con cita corta el resultado es ERROR', () => {
  const missing = citation.checkCitation({
    userId: 'u1',
    chunkId: null,
    quote: 'una cita suficientemente larga como para comprobarse',
    allowed,
  });
  const foreign = citation.checkCitation({
    userId: 'u2',
    chunkId: 'chunk-1',
    quote: 'un medio de la masa por la velocidad al cuadrado',
    allowed,
  });
  const unknown = citation.checkCitation({
    userId: 'u1',
    chunkId: 'inventado',
    quote: 'un medio de la masa por la velocidad al cuadrado',
    allowed,
  });
  const shortQuote = citation.checkCitation({
    userId: 'u1',
    chunkId: 'chunk-1',
    quote: 'masa',
    allowed,
  });

  for (const result of [missing, foreign, unknown, shortQuote]) {
    assert.equal(result.status, 'ERROR');
  }
});

ok('la cobertura no cuenta apartados omitidos', () => {
  const coverage = citation.citationCoverage([
    { status: 'COMPLETED', blocks: [{ quoteStatus: 'VERIFIED' }] },
    { status: 'PENDING', blocks: [{ quoteStatus: 'ERROR' }] },
    { status: 'SKIPPED', blocks: [{ quoteStatus: 'VERIFIED' }] },
  ]);
  assert.equal(coverage.withCitation, 1);
  assert.equal(coverage.total, 2);
  assert.equal(coverage.ratio, 0.5);
});

const note = {
  title: 'Dinámica',
  sections: [
    {
      id: 's1',
      title: 'Energía cinética',
      purpose: 'Definir y aplicar',
      order: 0,
      status: 'COMPLETED',
      blocks: [
        block({
          id: 'root',
          order: 0,
          content: 'La energía cinética depende de la masa y la velocidad.',
          quoteStatus: 'VERIFIED',
        }),
        block({
          id: 'variant',
          parentId: 'root',
          order: 1,
          type: 'EXAMPLE',
          content: 'Un coche de 1000 kg a 10 m/s tiene 50 kJ.',
        }),
      ],
    },
    {
      id: 's2',
      title: 'Fórmula',
      order: 1,
      status: 'COMPLETED',
      blocks: [block({ id: 'formula', type: 'FORMULA', content: 'E_c = \\frac{1}{2} m v^2' })],
    },
    {
      id: 's3',
      title: 'Apartado omitido',
      order: 2,
      status: 'SKIPPED',
      blocks: [block({ id: 'skipped', content: 'no debe salir' })],
    },
  ],
};

ok('la proyección es determinista byte a byte', () => {
  const first = projection.projectNoteMarkdown(note);
  const second = projection.projectNoteMarkdown(note);
  assert.equal(first, second);
  assert.equal(projection.projectionFingerprint(first), projection.projectionFingerprint(second));
});

ok('la proyección omite lo omitido y respeta el orden', () => {
  const markdown = projection.projectNoteMarkdown(note);
  assert.ok(!markdown.includes('no debe salir'));
  assert.ok(markdown.indexOf('Energía cinética') < markdown.indexOf('Fórmula'));
});

ok('las variantes cuelgan con encabezado y las fórmulas se encapsulan', () => {
  const markdown = projection.projectNoteMarkdown(note);
  assert.ok(markdown.includes('### Ejemplo'));
  assert.ok(markdown.includes('$$'));
  assert.ok(markdown.includes('E_c'));
});

ok('la proyección termina en un salto y nunca deja tres seguidos', () => {
  const markdown = projection.projectNoteMarkdown(note);
  assert.ok(markdown.endsWith('\n'));
  assert.ok(!markdown.includes('\n\n\n'));
  assert.notEqual(projection.projectionFingerprint(markdown), projection.projectionFingerprint(`${markdown}x`));
});

console.log(`\n  ${checks} comprobaciones en verde.\n`);
