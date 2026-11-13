/**
 * Verificación del motor puro del planificador (`src/lib/planner/engine.ts`).
 *
 * Se transpila el módulo real, no una copia. Todo es puro: sin base de datos,
 * sin IA y sin reloj global.
 *
 * Uso: `node scripts/verify-planificador.js`
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const sourcePath = path.join(__dirname, '..', 'src', 'lib', 'planner', 'engine.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

const module_ = { exports: {} };
new Function('exports', 'module', 'require', js)(module_.exports, module_, require);
const E = module_.exports;

const NOW = new Date('2026-11-13T18:00:00.000Z');
const base = {
  topicId: 't',
  subjectId: 's',
  title: 'Tema',
  subjectName: 'Materia',
  minutes: 15,
  priority: 0.5,
  deadline: null,
  mastery: 0.5,
  difficulty: 3,
  kind: 'repaso',
};

function candidate(overrides) {
  return { ...base, key: `${overrides.subjectId ?? base.subjectId}-${overrides.topicId ?? base.topicId}`, ...overrides };
}

function context(overrides = {}) {
  return {
    now: NOW,
    timezone: 'Europe/Madrid',
    energy: 1,
    capacityMin: 70,
    minBlockMin: 15,
    maxBlocks: 4,
    ...overrides,
  };
}

let checks = 0;
function ok(name, fn) {
  fn();
  checks += 1;
  console.log(`  ✓ ${name}`);
}

console.log('\n  Motor del planificador\n');

ok('capacidad = 70 % del tiempo disponible', () => {
  assert.equal(E.capacityFor(100), 70);
  assert.equal(E.capacityFor(143), 100);
  assert.equal(E.capacityFor(0), 0);
  assert.equal(E.capacityFor(-10), 0);
});

ok('no importa Prisma ni IA', () => {
  assert.ok(!source.includes('@prisma'));
  assert.ok(!source.includes('aiEngine'));
  assert.ok(!source.includes('Date.now'));
});

const candidates = [
  candidate({ key: 'a1', subjectId: 'A', topicId: '1', minutes: 15 }),
  candidate({ key: 'a2', subjectId: 'A', topicId: '2', minutes: 15 }),
  candidate({ key: 'a3', subjectId: 'A', topicId: '3', minutes: 15 }),
  candidate({ key: 'b1', subjectId: 'B', topicId: '4', minutes: 15 }),
  candidate({ key: 'b2', subjectId: 'B', topicId: '5', minutes: 15 }),
  candidate({ key: 'c1', subjectId: 'C', topicId: '6', minutes: 15 }),
  candidate({ key: 'c2', subjectId: 'C', topicId: '7', minutes: 15 }),
];

ok('determinista con el mismo contexto', () => {
  const a = E.pickBlocks(candidates, context()).map((block) => block.key);
  const b = E.pickBlocks(candidates, context()).map((block) => block.key);
  assert.deepEqual(a, b);
});

ok('determinista aunque cambie el orden de entrada', () => {
  const a = E.pickBlocks(candidates, context()).map((block) => block.key).sort();
  const shuffled = candidates.slice().reverse();
  const b = E.pickBlocks(shuffled, context()).map((block) => block.key).sort();
  assert.deepEqual(a, b);
});

ok('3–5 bloques, mínimo 10–15 min y máximo 2 por materia', () => {
  const blocks = E.pickBlocks(candidates, context({ capacityMin: 100, maxBlocks: 5 }));
  assert.ok(blocks.length >= 3 && blocks.length <= 5, `bloques=${blocks.length}`);
  for (const block of blocks) assert.ok(block.minutes >= 10);
  const perSubject = {};
  for (const block of blocks) perSubject[block.subjectId] = (perSubject[block.subjectId] ?? 0) + 1;
  for (const count of Object.values(perSubject)) assert.ok(count <= 2, `materia con ${count}`);
});

ok('no supera la capacidad', () => {
  const blocks = E.pickBlocks(candidates, context({ capacityMin: 45, maxBlocks: 5 }));
  const total = blocks.reduce((sum, block) => sum + block.minutes, 0);
  assert.ok(total <= 45, `total=${total}`);
  assert.ok(blocks.length >= 3, `bloques=${blocks.length}`);
});

ok('descarta bloques por debajo del mínimo', () => {
  const blocks = E.pickBlocks(
    [candidate({ key: 'corto', minutes: 9 }), ...candidates],
    context()
  );
  assert.ok(!blocks.some((block) => block.key === 'corto'));
});

ok('un examen a dos días adelanta a una unidad nueva', () => {
  const exam = candidate({
    key: 'examen',
    topicId: 'x',
    kind: 'examen',
    priority: 0.6,
    deadline: new Date('2026-11-15T10:00:00.000Z'),
  });
  const nuevo = candidate({ key: 'nuevo', topicId: 'y', kind: 'nuevo', priority: 0.9 });
  const blocks = E.pickBlocks([nuevo, exam, ...candidates], context({ capacityMin: 30, maxBlocks: 3 }));
  assert.equal(blocks[0].key, 'examen');
});

ok('la energía alta favorece lo nuevo y la baja el repaso', () => {
  const nuevo = candidate({ key: 'nuevo', topicId: 'y', kind: 'nuevo' });
  const repaso = candidate({ key: 'repaso', topicId: 'z', kind: 'repaso' });
  const alto = E.pickBlocks([nuevo, repaso], context({ energy: 1.2, capacityMin: 30, maxBlocks: 3 }));
  const bajo = E.pickBlocks([nuevo, repaso], context({ energy: 0.5, capacityMin: 30, maxBlocks: 3 }));
  assert.equal(alto[0].key, 'nuevo');
  assert.equal(bajo[0].key, 'repaso');
});

ok('intercala materias cuando hay alternativa', () => {
  const blocks = [
    candidate({ key: 'a1', subjectId: 'A' }),
    candidate({ key: 'a2', subjectId: 'A' }),
    candidate({ key: 'b1', subjectId: 'B' }),
  ];
  const ordered = E.interleave(blocks).map((block) => block.key);
  assert.deepEqual(ordered, ['a1', 'b1', 'a2']);
});

ok('clampa los límites del contrato', () => {
  const many = Array.from({ length: 12 }, (_, index) =>
    candidate({ key: `k${index}`, subjectId: `S${index % 6}`, topicId: `t${index}` })
  );
  const blocks = E.pickBlocks(many, context({ capacityMin: 300, maxBlocks: 99 }));
  assert.equal(blocks.length, 5);
  assert.ok(!E.pickBlocks([], context()).length);
});

console.log(`\n  ✅ ${checks} comprobaciones en verde\n`);
