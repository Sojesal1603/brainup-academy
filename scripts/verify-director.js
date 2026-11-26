/**
 * Verificación de la Fase 5: director determinista + estado compartido.
 *
 * Todo lo que se prueba aquí es puro (sin base, sin red y sin IA):
 *
 *   a) El estado se versiona de forma estable y cambia cuando cambia un dato.
 *   b) Las desviaciones producen una decisión determinista: atraso, sobrecarga,
 *      examen próximo, repasos/errores y estado limpio.
 *   c) La política de reconstrucción es idempotente: tras reajustar, la segunda
 *      lectura no vuelve a escribir. El lock real de PostgreSQL se comprueba en
 *      el código que lo usa (`ensureTodayPlan`).
 *   d) La narración IA solo existe en `after()`, no en la ruta de apertura.
 *
 * Uso: `npm run verify:director`.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { compilaTs } = require('./lib/compilaTs');

const projectRoot = path.join(__dirname, '..');
const outDir = compilaTs(['director/studentState', 'dailyBriefContract'], '.tmp-verify-director');
const director = require(path.join(outDir, 'director', 'studentState.js'));
const briefLib = require(path.join(outDir, 'dailyBriefContract.js'));

let checks = 0;
function ok(name, fn) {
  fn();
  checks += 1;
  console.log(`  ✓ ${name}`);
}

const NOW = new Date('2026-11-26T18:00:00.000Z');

function unit(overrides = {}) {
  return {
    id: overrides.id ?? 'u-1',
    title: overrides.title ?? 'Campo gravitatorio',
    subjectId: overrides.subjectId ?? 's-fisica',
    subjectName: overrides.subjectName ?? 'Física',
    subjectColor: overrides.subjectColor ?? '#22d3ee',
    mastery: overrides.mastery ?? 0.4,
    measured: overrides.measured ?? true,
    status: overrides.status ?? 'en_curso',
    errorsOpen: overrides.errorsOpen ?? 0,
    daysToExam: overrides.daysToExam ?? null,
    examTitle: overrides.examTitle ?? null,
    ...overrides,
  };
}

function session(overrides = {}) {
  return {
    id: overrides.id ?? 'b-1',
    subjectId: overrides.subjectId ?? 's-fisica',
    topicTitle: overrides.topicTitle ?? 'Campo gravitatorio',
    durationMinutes: overrides.durationMinutes ?? 25,
    isCompleted: overrides.isCompleted ?? false,
    status: overrides.status ?? 'pendiente',
    ...overrides,
  };
}

function stateInput(overrides = {}) {
  return {
    now: NOW,
    dayKey: '2026-11-26',
    timezone: 'Europe/Madrid',
    energy: 'media',
    energyChosen: true,
    availableMinutes: 120,
    plannedMinutes: 75,
    completedMinutes: 0,
    studiedMinutes: 0,
    dueReviews: 0,
    errorsOpen: 0,
    streakCurrent: 0,
    studiedToday: false,
    rescheduledBlocks: 0,
    pausedBlocks: 0,
    staleBlocks: 0,
    units: [unit()],
    sessions: [
      session(),
      session({ id: 'b-2', subjectId: 's-mates', topicTitle: 'Derivadas', durationMinutes: 25 }),
      session({ id: 'b-3', subjectId: 's-lengua', topicTitle: 'Comentario', durationMinutes: 25 }),
    ],
    ...overrides,
  };
}

console.log('\n  Director determinista y estado del alumno\n');

console.log('  1) Estado versionado');

ok('la misma foto produce la misma versión y el mismo estado', () => {
  const a = director.buildStudentState(stateInput());
  const b = director.buildStudentState(stateInput());
  assert.equal(a.version, b.version);
  assert.deepEqual(a, b);
  assert.match(a.version, /^director-v1-[0-9a-f]{8}$/);
});

ok('la versión no cambia por el orden de las unidades o de las sesiones', () => {
  const ordered = director.buildStudentState(
    stateInput({
      units: [unit({ id: 'u-1' }), unit({ id: 'u-2', subjectId: 's-mates', subjectName: 'Matemáticas' })],
    })
  );
  const shuffled = director.buildStudentState(
    stateInput({
      units: [unit({ id: 'u-2', subjectId: 's-mates', subjectName: 'Matemáticas' }), unit({ id: 'u-1' })],
      sessions: [
        session({ id: 'b-3', subjectId: 's-lengua', topicTitle: 'Comentario' }),
        session({ id: 'b-1', subjectId: 's-fisica' }),
        session({ id: 'b-2', subjectId: 's-mates', topicTitle: 'Derivadas' }),
      ],
    })
  );
  assert.equal(ordered.version, shuffled.version);
});

ok('la versión cambia cuando aparece un examen o un bloque atrasado', () => {
  const base = director.buildStudentState(stateInput());
  const exam = director.buildStudentState(
    stateInput({
      units: [unit({ daysToExam: 2, examTitle: 'Parcial de Física' })],
    })
  );
  const stale = director.buildStudentState(stateInput({ staleBlocks: 2 }));
  assert.notEqual(exam.version, base.version);
  assert.notEqual(stale.version, base.version);
});

ok('agrega materias, unidades medidas y errores reales', () => {
  const state = director.buildStudentState(
    stateInput({
      errorsOpen: 5,
      units: [
        unit({ id: 'u-1', subjectId: 's-fisica', subjectName: 'Física', measured: true, errorsOpen: 2 }),
        unit({ id: 'u-2', subjectId: 's-fisica', subjectName: 'Física', measured: false }),
        unit({ id: 'u-3', subjectId: 's-mates', subjectName: 'Matemáticas', measured: true, errorsOpen: 3 }),
      ],
    })
  );
  assert.equal(state.units.total, 3);
  assert.equal(state.units.measured, 2);
  assert.equal(state.errorsOpen, 5);
  assert.equal(state.subjects.length, 2);
  assert.equal(state.subjects.find((subject) => subject.id === 's-fisica').measuredUnits, 1);
});

console.log('\n  2) Desviaciones y decisiones');

ok('un bloque atrasado obliga a reajustar', () => {
  const state = director.buildStudentState(stateInput({ staleBlocks: 2 }));
  assert.equal(state.decision, 'replan');
  assert.equal(state.deviations[0].code, 'atraso');
  assert.match(state.summary, /reajusta/i);
});

ok('un plan que no cabe reduce el alcance', () => {
  const state = director.buildStudentState(
    stateInput({ availableMinutes: 30, plannedMinutes: 90 })
  );
  assert.equal(state.decision, 'reduce');
  assert.ok(state.deviations.some((deviation) => deviation.code === 'sobrecarga'));
});

ok('un examen a tres días manda sobre repasos y errores', () => {
  const state = director.buildStudentState(
    stateInput({
      dueReviews: 5,
      errorsOpen: 2,
      units: [unit({ daysToExam: 2, examTitle: 'Parcial de Física' })],
    })
  );
  assert.equal(state.decision, 'prioritize_exam');
  assert.ok(state.deviations.some((deviation) => deviation.code === 'examen'));
  assert.ok(state.deviations.some((deviation) => deviation.code === 'repasos'));
});

ok('sin desviaciones el director mantiene la ruta', () => {
  const state = director.buildStudentState(stateInput());
  assert.equal(state.decision, 'hold');
  assert.equal(state.deviations.length, 0);
  assert.match(state.summary, /mantiene el plan/i);
});

console.log('\n  3) Reconstrucción, idempotencia y concurrencia');

ok('prioriza invalidación y atraso antes que un plan sin bloques', () => {
  assert.equal(
    director.directorReplanReason({ planStatus: 'invalidated', liveBlocks: 3, staleBlocks: 2 }),
    'plan_invalidado'
  );
  assert.equal(
    director.directorReplanReason({ planStatus: 'active', liveBlocks: 3, staleBlocks: 2 }),
    'atraso'
  );
  assert.equal(
    director.directorReplanReason({ planStatus: 'active', liveBlocks: 0, staleBlocks: 0 }),
    'sin_bloques'
  );
  assert.equal(
    director.directorReplanReason({ planStatus: 'active', liveBlocks: 3, staleBlocks: 0 }),
    null
  );
});

ok('la segunda lectura tras reajustar no vuelve a reconstruir', () => {
  const first = { planStatus: 'active', liveBlocks: 3, staleBlocks: 2 };
  assert.equal(director.shouldRegeneratePlan(first), true);
  const second = { planStatus: 'active', liveBlocks: 3, staleBlocks: 0 };
  assert.equal(director.shouldRegeneratePlan(second), false);
});

ok('la narración solo recibe hechos, no decide ni nombra proveedores', () => {
  const state = director.buildStudentState(
    stateInput({ units: [unit({ daysToExam: 2, examTitle: 'Parcial de Física' })] })
  );
  const facts = director.buildDirectorNarrationFacts(state);
  assert.ok(facts.some((fact) => /Decisión: prioritize_exam/.test(fact)));
  assert.ok(facts.some((fact) => /Próximo examen/.test(fact)));
  assert.ok(!facts.join(' ').match(/\b(gemini|groq|openai|anthropic|gpt|claude)\b/i));
});

ok('el DailyBrief publica el estado del director sin IA', () => {
  const state = director.buildStudentState(stateInput());
  const plan = {
    dayKey: '2026-11-26',
    headline: 'Hoy toca esto',
    availableMinutes: 120,
    plannedMinutes: 75,
    breakMinutes: 15,
    completedMinutes: 0,
    studiedMinutes: 0,
    energy: 'media',
    sessions: [],
    dueReviews: 0,
    errorsOpen: 0,
    recovery: { active: false, headline: '' },
    emptyReason: null,
    director: state,
  };
  const brief = briefLib.buildDailyBrief(plan, { generatedAtIso: NOW.toISOString() });
  assert.equal(brief.director.version, state.version);
  assert.equal(brief.generatedBy, 'rules');
  assert.equal(brief.narrationStatus, 'skipped');
});

console.log('\n  4) Integración real: lock, reajuste y after()');
const dayPlan = fs.readFileSync(path.join(projectRoot, 'src/lib/dayPlan.ts'), 'utf8');
const narration = fs.readFileSync(path.join(projectRoot, 'src/lib/director/narration.ts'), 'utf8');
const dashboard = fs.readFileSync(
  path.join(projectRoot, 'src/components/cuartel/DashboardWidgets.tsx'),
  'utf8'
);
const hoy = fs.readFileSync(path.join(projectRoot, 'src/components/cuartel/HoyTocaEsto.tsx'), 'utf8');
const packageJson = fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8');

ok('el planificador conserva el advisory lock y decide dentro de él', () => {
  assert.match(dayPlan, /pg_advisory_xact_lock/);
  assert.match(dayPlan, /directorReplanReason/);
  const lock = dayPlan.indexOf('pg_advisory_xact_lock');
  const decide = dayPlan.indexOf('const reason = directorReplanReason');
  const persist = dayPlan.indexOf('await persistDayPlan(userId, { day: todayStart, now })');
  assert.ok(lock >= 0 && decide > lock && persist > decide, 'el orden del lock no es correcto');
});

ok('el motor puro no importa Prisma ni IA', () => {
  const pure = fs.readFileSync(path.join(projectRoot, 'src/lib/director/studentState.ts'), 'utf8');
  assert.ok(!pure.includes('@prisma'));
  assert.ok(!pure.includes('aiEngine'));
  assert.ok(!pure.includes('Date.now'));
});

ok('la narración IA vive en after y no bloquea la apertura', () => {
  assert.match(dashboard, /import \{ after \} from 'next\/server'/);
  assert.match(dashboard, /after\(async \(\) =>/);
  assert.match(dashboard, /ensureDirectorNarration/);
  assert.match(narration, /priority: 'fondo'/);
  assert.match(narration, /AgentMemory|agentMemory/);
  assert.match(hoy, /plan\.director\?\.summary/);
});

ok('el script está registrado en package.json', () => {
  assert.match(packageJson, /"verify:director": "node scripts\/verify-director\.js"/);
});

console.log(`\n  ${checks} comprobaciones en verde. Director determinista y estado compartido.\n`);
