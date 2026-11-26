/**
 * Verificación del motor visual, sin navegador ni base de datos.
 *
 *   · las diez construcciones exactas (mediatriz, tangentes, cortes, giros,
 *     abatimientos, polígonos, paralelas y perpendiculares);
 *   · la validación de `VisualSpec`: JSON, HTML, ids, referencias y límites;
 *   · que la spec sobreviva al limpiador de apuntes y se pueda reabrir;
 *   · que el prompt del tutor solo permita construcciones, nunca SVG.
 *
 * Uso: `npm run verify:visual`
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { compilaTs } = require('./lib/compilaTs');

const outDir = compilaTs(
  ['visual/spec', 'visual/prompt', 'apuntesIa'],
  '.tmp-verify-visual'
);

const visual = require(path.join(outDir, 'visual', 'spec.js'));
const prompt = require(path.join(outDir, 'visual', 'prompt.js'));
const apuntes = require(path.join(outDir, 'apuntesIa.js'));

let checks = 0;
function ok(name, fn) {
  fn();
  checks += 1;
  console.log(`  ✓ ${name}`);
}

function near(actual, expected, epsilon = 1e-5) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `se esperaba ${expected} y salió ${actual}`
  );
}

function parse(input) {
  const result = visual.parseVisualSpec(input);
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  return result.visual;
}

function primitive(parsed, id) {
  const found = parsed.solution.primitives.find((item) => item.id === id);
  assert.ok(found, `no existe la primitiva ${id}`);
  return found;
}

function at(parsed, id) {
  const found = primitive(parsed, id);
  assert.ok(found.type === 'point', `${id} no es un punto`);
  return found.at;
}

function specWith(construction) {
  return {
    version: 1,
    kind: 'technical',
    title: 'Trazado de prueba',
    construction,
  };
}

console.log('\n  Motor visual y dibujo técnico\n');

ok('una construcción válida produce figura, pasos y viewBox', () => {
  const parsed = parse(
    specWith({ kind: 'perpendicular_bisector', a: [0, 0], b: [100, 0] })
  );
  assert.equal(parsed.spec.title, 'Trazado de prueba');
  assert.equal(parsed.solution.steps.length, 3);
  assert.ok(parsed.solution.primitives.length >= 8);
  assert.ok(parsed.solution.viewBox.width > 0);
  assert.ok(parsed.solution.viewBox.height > 0);
  assert.ok(Number.isFinite(parsed.solution.viewBox.x));
});

ok('el fingerprint es estable aunque cambie el orden de las claves', () => {
  const first = parse(
    JSON.stringify({
      version: 1,
      title: 'Igual',
      construction: { kind: 'midpoint', a: [0, 0], b: [10, 0] },
    })
  );
  const second = parse(
    JSON.stringify({
      construction: { b: [10, 0], a: [0, 0], kind: 'midpoint' },
      title: 'Igual',
      version: 1,
    })
  );
  assert.equal(first.fingerprint, second.fingerprint);
});

ok('acepta el contenido de una valla visual y rechaza JSON roto', () => {
  const fenced = '```visual\n{"version":1,"title":"Punto","construction":{"kind":"midpoint","a":[0,0],"b":[20,0]}}\n```';
  assert.equal(parse(fenced).spec.title, 'Punto');

  const broken = visual.parseVisualSpec('{"version":1,');
  assert.equal(broken.ok, false);
  assert.match(broken.error, /JSON/i);
});

ok('el texto de una figura no puede colar HTML', () => {
  const result = visual.parseVisualSpec({
    version: 1,
    title: '<script>alert(1)</script>',
    primitives: [
      { type: 'point', id: 'a', at: [0, 0], label: 'A' },
    ],
  });
  assert.equal(result.ok, false);
});

ok('rechaza ids repetidos y pasos que apuntan a primitivas inexistentes', () => {
  const duplicate = visual.parseVisualSpec({
    version: 1,
    title: 'Duplicada',
    primitives: [
      { type: 'point', id: 'a', at: [0, 0] },
      { type: 'point', id: 'a', at: [10, 0] },
    ],
  });
  assert.equal(duplicate.ok, false);

  const missing = visual.parseVisualSpec({
    version: 1,
    title: 'Paso roto',
    primitives: [{ type: 'point', id: 'a', at: [0, 0] }],
    steps: [{ id: 's1', title: 'Paso', visible: ['no-existe'] }],
  });
  assert.equal(missing.ok, false);
});

ok('exige una sola forma: construction o primitives', () => {
  const none = visual.parseVisualSpec({ version: 1, title: 'Vacía' });
  assert.equal(none.ok, false);

  const both = visual.parseVisualSpec({
    version: 1,
    title: 'Doble',
    construction: { kind: 'midpoint', a: [0, 0], b: [10, 0] },
    primitives: [{ type: 'point', id: 'a', at: [0, 0] }],
  });
  assert.equal(both.ok, false);
});

ok('la mediatriz pasa por el punto medio y es perpendicular a AB', () => {
  const parsed = parse(
    specWith({ kind: 'perpendicular_bisector', a: [0, 0], b: [100, 0] })
  );
  const middle = at(parsed, 'p-m');
  near(middle[0], 50);
  near(middle[1], 0);

  const bisector = primitive(parsed, 'seg-mediatriz');
  assert.equal(bisector.type, 'segment');
  near(bisector.from[0], bisector.to[0]);
  near(Math.abs(bisector.from[1] - bisector.to[1]) > 1, true);
});

ok('la perpendicular por un punto exterior cae en el pie exacto', () => {
  const parsed = parse(
    specWith({
      kind: 'perpendicular_through_point',
      line: [[0, 0], [100, 0]],
      point: [30, 40],
    })
  );
  const foot = at(parsed, 'p-f');
  near(foot[0], 30);
  near(foot[1], 0);

  const segment = primitive(parsed, 'seg-perp');
  assert.equal(segment.type, 'segment');
  near(segment.from[0], 30);
  near(segment.to[0], 30);
});

ok('la paralela conserva la dirección y pasa por el punto pedido', () => {
  const parsed = parse(
    specWith({
      kind: 'parallel_through_point',
      line: [[0, 10], [100, 10]],
      point: [0, 50],
    })
  );
  const parallel = primitive(parsed, 'seg-paralela');
  assert.equal(parallel.type, 'segment');
  near(parallel.from[1], 50);
  near(parallel.to[1], 50);
  near(parallel.from[1], parallel.to[1]);
});

ok('la bisectriz de un ángulo recto sale a 45°', () => {
  const parsed = parse(
    specWith({
      kind: 'angle_bisector',
      vertex: [0, 0],
      from: [100, 0],
      to: [0, 100],
    })
  );
  const bisector = primitive(parsed, 'seg-bisectriz');
  assert.equal(bisector.type, 'segment');
  near(bisector.to[0], bisector.to[1], 1e-4);
  assert.ok(bisector.to[0] > 0);
});

ok('la intersección de dos rectas es exacta', () => {
  const parsed = parse(
    specWith({
      kind: 'line_intersection',
      line1: [[0, 0], [100, 100]],
      line2: [[0, 100], [100, 0]],
    })
  );
  const x = at(parsed, 'p-x');
  near(x[0], 50);
  near(x[1], 50);
});

ok('las tangentes desde un punto exterior son tangentes de verdad', () => {
  const parsed = parse(
    specWith({
      kind: 'tangent_from_point',
      center: [0, 0],
      radius: 50,
      point: [100, 0],
    })
  );

  for (const id of ['p-t1', 'p-t2']) {
    const tangent = at(parsed, id);
    near(Math.hypot(tangent[0], tangent[1]), 50, 1e-5);
    const dot = tangent[0] * (100 - tangent[0]) + tangent[1] * (0 - tangent[1]);
    near(dot, 0, 1e-4);
  }
});

ok('el giro conserva el radio y lleva (100,0) a (0,100)', () => {
  const parsed = parse(
    specWith({ kind: 'rotate', point: [100, 0], center: [0, 0], angleDeg: 90 })
  );
  const q = at(parsed, 'p-q');
  near(q[0], 0, 1e-5);
  near(q[1], 100, 1e-5);
});

ok('el punto medio y el abatimiento se calculan sin inventar coordenadas', () => {
  const middle = parse(specWith({ kind: 'midpoint', a: [-10, 20], b: [30, 20] }));
  const m = at(middle, 'p-m');
  near(m[0], 10);
  near(m[1], 20);

  const reflected = parse(
    specWith({
      kind: 'reflect_point',
      point: [20, 30],
      line: [[0, 0], [100, 0]],
    })
  );
  const q = at(reflected, 'p-q');
  near(q[0], 20);
  near(q[1], -30);
});

ok('el polígono regular reparte sus vértices a radio constante', () => {
  const parsed = parse(
    specWith({
      kind: 'regular_polygon',
      center: [0, 0],
      radius: 50,
      sides: 4,
      rotationDeg: 45,
    })
  );
  const polygon = primitive(parsed, 'poly');
  assert.equal(polygon.type, 'polygon');
  assert.equal(polygon.points.length, 4);
  for (const vertex of polygon.points) {
    near(Math.hypot(vertex[0], vertex[1]), 50, 1e-5);
  }
  near(polygon.points[0][0], 50 / Math.SQRT2, 1e-5);
});

ok('una mediatriz degenerada, dos paralelas o un punto interior fallan con error', () => {
  const degenerate = visual.parseVisualSpec(
    specWith({ kind: 'perpendicular_bisector', a: [10, 10], b: [10, 10] })
  );
  assert.equal(degenerate.ok, false);

  const parallel = visual.parseVisualSpec(
    specWith({
      kind: 'line_intersection',
      line1: [[0, 0], [100, 0]],
      line2: [[0, 20], [100, 20]],
    })
  );
  assert.equal(parallel.ok, false);

  const inside = visual.parseVisualSpec(
    specWith({
      kind: 'tangent_from_point',
      center: [0, 0],
      radius: 50,
      point: [10, 0],
    })
  );
  assert.equal(inside.ok, false);
});

ok('los esquemas libres usan primitivas y un paso completo por defecto', () => {
  const parsed = parse({
    version: 1,
    kind: 'diagram',
    title: 'Esquema libre',
    primitives: [
      { type: 'point', id: 'a', at: [0, 0], label: 'A', role: 'given' },
      { type: 'point', id: 'b', at: [100, 0], label: 'B', role: 'given' },
      { type: 'segment', id: 'ab', from: [0, 0], to: [100, 0], style: 'accent' },
      { type: 'dimension', id: 'd', from: [0, 0], to: [100, 0], label: '100 u' },
    ],
  });
  assert.equal(parsed.solution.steps.length, 1);
  assert.equal(parsed.solution.steps[0].visible.length, 4);
  assert.ok(parsed.solution.primitives.some((item) => item.type === 'dimension'));
});

ok('rechaza coordenadas fuera del límite seguro', () => {
  const result = visual.parseVisualSpec({
    version: 1,
    title: 'Fuera',
    primitives: [{ type: 'point', id: 'a', at: [100001, 0] }],
  });
  assert.equal(result.ok, false);
});

ok('el limpiador de apuntes conserva la valla visual y quita el código normal', () => {
  const source = [
    'Antes',
    '```visual',
    '{"version":1,"title":"Punto","construction":{"kind":"midpoint","a":[0,0],"b":[20,0]}}',
    '```',
    'Después',
    '```js',
    'console.log("esto no debe quedar como valla")',
    '```',
  ].join('\n');

  const clean = apuntes.sanitizeNoteContent(source);
  assert.ok(clean.includes('```visual'));
  assert.ok(clean.includes('"perpendicular_bisector"') || clean.includes('"midpoint"'));
  assert.ok(!clean.includes('```js'));
});

ok('el prompt solo ofrece construcciones y prohíbe SVG/HTML', () => {
  assert.ok(prompt.VISUAL_PROMPT.includes('```visual'));
  assert.ok(prompt.VISUAL_PROMPT.includes('perpendicular_bisector'));
  assert.ok(prompt.VISUAL_PROMPT.includes('tangent_from_point'));
  assert.ok(prompt.VISUAL_PROMPT.includes('regular_polygon'));
  assert.ok(/SVG|HTML/i.test(prompt.VISUAL_PROMPT));
  assert.ok(/no inventes coordenadas/i.test(prompt.VISUAL_PROMPT));
});

ok('detecta peticiones de trazado o imagen paso a paso', () => {
  const pide = [
    'explícame la traslación mediante arcos de compás',
    'hazme la mediatriz de AB paso a paso',
    'quiero ver imágenes paso a paso de la construcción',
    'dibújame la bisectriz del ángulo',
    'un esquema visual de la tangente a la circunferencia',
  ];
  for (const text of pide) {
    assert.equal(prompt.needsVisualSpec(text), true, text);
  }

  const noPide = [
    'explícame paso a paso la derivada de x al cuadrado',
    'resume la guerra civil española',
    'dame tres ejercicios de integrales',
  ];
  for (const text of noPide) {
    assert.equal(prompt.needsVisualSpec(text), false, text);
  }

  assert.equal(prompt.needsVisualSpec('explícame el alzado', 'Dibujo Técnico'), true);
});

ok('la petición visual añade el requisito y sus ejemplos parsean con Zod', () => {
  const text = prompt.VISUAL_REQUIRED_PROMPT;
  assert.ok(text.includes('NO PUEDES RESPONDER SOLO CON TEXTO'));
  assert.ok(text.includes('```visual'));
  assert.ok(text.includes('perpendicular_bisector'));
  assert.ok(text.includes('"primitives"'));

  const examples = [...text.matchAll(/```visual\n([\s\S]*?)\n```/g)].map((match) => match[1]);
  assert.ok(examples.length >= 2, 'faltan ejemplos visuales en el prompt');
  for (const example of examples) {
    const parsed = visual.parseVisualSpec(example);
    assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.error);
  }
  assert.ok(examples.some((example) => example.includes('"construction"')));
  assert.ok(examples.some((example) => example.includes('"primitives"')));
});

ok('el prompt de apuntes tecnológicos añade el contrato visual', () => {
  const tech = apuntes.buildNoteWriterInstructions('tecnologia');
  const human = apuntes.buildNoteWriterInstructions('humanidades');
  assert.ok(tech.includes('```visual'));
  assert.ok(!human.includes('```visual'));
});

ok('el chat y los apuntes montan la tarjeta, y el tutor recibe el contrato', () => {
  const root = path.join(__dirname, '..');
  const markdown = fs.readFileSync(
    path.join(root, 'src', 'components', 'brainup', 'MarkdownMessage.tsx'),
    'utf8'
  );
  const notes = fs.readFileSync(
    path.join(root, 'src', 'components', 'apuntes', 'NoteRenderer.tsx'),
    'utf8'
  );
  const tutor = fs.readFileSync(path.join(root, 'src', 'lib', 'tutor.ts'), 'utf8');
  const route = fs.readFileSync(
    path.join(root, 'src', 'app', 'api', 'tutor', 'route.ts'),
    'utf8'
  );

  assert.ok(markdown.includes("startsWith('visual')"));
  assert.ok(markdown.includes('<VisualBlock'));
  assert.ok(notes.includes("startsWith('visual')"));
  assert.ok(notes.includes('<VisualBlock'));
  assert.ok(tutor.includes('VISUAL_PROMPT'));
  assert.ok(tutor.includes('VISUAL_REQUIRED_PROMPT'));
  assert.ok(tutor.includes('visualRequired'));
  assert.ok(route.includes('needsVisualSpec'));
  assert.ok(route.includes('const visualRequired'));
  assert.ok(route.includes('visualRequired,'));
  assert.ok(route.includes('RECORDATORIO FINAL'));
  assert.ok(markdown.includes("import dynamic from 'next/dynamic'"));
  assert.ok(markdown.includes('ssr: false'));
});

console.log(`\n  ${checks} comprobaciones en verde.\n`);
