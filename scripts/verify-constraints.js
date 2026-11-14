/**
 * Verificación del paso 9: restricciones y contexto del catedrático.
 *
 *   - Zod acepta las tres restricciones válidas y rechaza minutos fuera de
 *     rango, tipos desconocidos y más de cinco;
 *   - si el modelo devuelve una restricción inválida, se rechaza TODA la
 *     propuesta (no se guarda lo que «se haya podido entender»);
 *   - el responseSchema de Gemini no contiene ningún userId;
 *   - el intérprete usa responseMimeType/responseSchema y no manda userId;
 *   - la apertura de apuntes se ejecuta con el userId de la sesión, sin SSE y
 *     con NoteSplitPanel;
 *   - el saludo del catedrático se construye por reglas.
 *
 * Uso: `node scripts/verify-constraints.js`
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { compilaTs, projectRoot } = require('./lib/compilaTs');

const outDir = compilaTs('planner/constraints', '.tmp-verify-constraints');
const constraints = require(path.join(outDir, 'constraints.js'));

let checks = 0;
function ok(name, fn) {
  fn();
  checks += 1;
  console.log(`  ✓ ${name}`);
}

console.log('\n  Restricciones y contexto del catedrático\n');

ok('acepta máximo de minutos, evitar materia y solo materia', () => {
  const parsed = constraints.planConstraintsSchema.parse([
    { kind: 'max_minutes', minutes: 45 },
    { kind: 'avoid_subject', subject: 'Filosofía' },
    { kind: 'only_subject', subject: 'Matemáticas' },
  ]);
  assert.equal(parsed.length, 3);
  assert.equal(constraints.constraintLabel(parsed[0]), 'Máximo 45 min hoy');
  assert.equal(constraints.constraintLabel(parsed[1]), 'Sin Filosofía hoy');
  assert.equal(constraints.constraintLabel(parsed[2]), 'Solo Matemáticas hoy');
});

ok('rechaza minutos fuera de rango, tipos desconocidos y más de cinco', () => {
  assert.equal(
    constraints.planConstraintsSchema.safeParse([{ kind: 'max_minutes', minutes: 5 }]).success,
    false
  );
  assert.equal(
    constraints.planConstraintsSchema.safeParse([{ kind: 'max_minutes', minutes: 500 }]).success,
    false
  );
  assert.equal(
    constraints.planConstraintsSchema.safeParse([{ kind: 'borrar_todo' }]).success,
    false
  );
  const six = Array.from({ length: 6 }, () => ({ kind: 'max_minutes', minutes: 30 }));
  assert.equal(constraints.planConstraintsSchema.safeParse(six).success, false);
});

ok('una restricción inválida invalida la propuesta entera', () => {
  const mixed = JSON.stringify({
    constraints: [
      { kind: 'max_minutes', minutes: 45 },
      { kind: 'avoid_subject', subject: '' },
    ],
  });
  assert.equal(constraints.parseConstraintModelJson(mixed).ok, false);

  const good = JSON.stringify({ constraints: [{ kind: 'max_minutes', minutes: 45 }] });
  const parsed = constraints.parseConstraintModelJson(good);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.constraints[0].minutes, 45);

  assert.equal(constraints.parseConstraintModelJson('no es json').ok, false);
  assert.equal(constraints.parseConstraintModelJson('{"constraints":[]}').ok, true);
});

ok('el responseSchema de Gemini no contiene userId', () => {
  const schema = JSON.stringify(constraints.PLAN_CONSTRAINT_RESPONSE_SCHEMA);
  assert.ok(!/userId|user_id/i.test(schema), schema);
  assert.ok(schema.includes('responseSchema') === false); // el objeto es solo el schema
  assert.ok(schema.includes('max_minutes'));
});

ok('las materias se comparan sin distinguir mayúsculas ni acentos de caja', () => {
  const rules = [
    { kind: 'avoid_subject', subject: 'Filosofía' },
    { kind: 'only_subject', subject: 'Matemáticas' },
  ];
  assert.equal(constraints.subjectAllowedByConstraints(rules, 'filosofía'), false);
  assert.equal(constraints.subjectAllowedByConstraints(rules, 'MATEMÁTICAS'), true);
  assert.equal(constraints.subjectAllowedByConstraints(rules, 'Física'), false);
  assert.equal(constraints.maxMinutesFromConstraints(rules), null);
  assert.equal(
    constraints.maxMinutesFromConstraints([
      { kind: 'max_minutes', minutes: 60 },
      { kind: 'max_minutes', minutes: 30 },
    ]),
    30
  );
});

ok('el intérprete pide JSON con responseSchema y no manda userId', () => {
  const source = fs.readFileSync(
    path.join(projectRoot, 'src/lib/planner/constraintAi.ts'),
    'utf8'
  );
  assert.ok(source.includes('responseMimeType'));
  assert.ok(source.includes('responseSchema'));
  assert.ok(source.includes('generateContent'));
  const bodyStart = source.indexOf('body: JSON.stringify({');
  const bodyEnd = source.indexOf('signal:', bodyStart);
  assert.ok(bodyStart > 0 && bodyEnd > bodyStart);
  const requestBody = source.slice(bodyStart, bodyEnd);
  assert.ok(!/userId/i.test(requestBody), 'la petición a Gemini no debe llevar userId');
});

ok('abrir un apunte usa el userId de la sesión y no SSE', () => {
  const openDoc = fs.readFileSync(path.join(projectRoot, 'src/lib/tutorDocuments.ts'), 'utf8');
  assert.ok(/openDocument\(\s*userId: string/.test(openDoc));
  assert.ok(openDoc.includes('db(userId)'));

  const route = fs.readFileSync(path.join(projectRoot, 'src/app/api/tutor/route.ts'), 'utf8');
  assert.ok(route.includes('openDocument(authUser.id'));
  assert.ok(route.includes('?doc=note:'));
  assert.ok(!/text\/event-stream/.test(route), 'el tutor no debe usar SSE');

  const chat = fs.readFileSync(
    path.join(projectRoot, 'src/components/brainup/TutorChat.tsx'),
    'utf8'
  );
  assert.ok(chat.includes('NoteSplitPanel'));
  assert.ok(chat.includes('window.history.replaceState'));
});

ok('el saludo del catedrático se construye por reglas, sin IA', () => {
  const source = fs.readFileSync(
    path.join(projectRoot, 'src/components/brainup/TutorChat.tsx'),
    'utf8'
  );
  const start = source.indexOf('function buildOpeningMessage');
  assert.ok(start > 0);
  const body = source.slice(start, start + 2200);
  assert.ok(!/fetch\(|runAiText|applyAi/.test(body), 'el saludo no debe llamar a la IA');
  assert.ok(body.includes('teacherMethodLabel'));
});

console.log(`\n  ✅ ${checks} comprobaciones en verde\n`);
