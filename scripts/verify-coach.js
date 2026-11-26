/**
 * Verificación del coach pedagógico, sin base de datos ni red.
 *
 *   · detecta patrones solo con datos presentes y no inventa porcentajes;
 *   · traduce errores, bloques fallidos, tiempos y autonomía a ajustes;
 *   · distingue “sin medición” de “nivel bajo”;
 *   · el mismo contenido produce el mismo fingerprint en cualquier orden;
 *   · el perfil guardado se valida y queda aislado por usuario/materia.
 *
 * Uso: `npm run verify:coach`
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { compilaTs } = require('./lib/compilaTs');

const outDir = compilaTs('coach/profile', '.tmp-verify-coach');
const coach = require(path.join(outDir, 'coach', 'profile.js'));
const root = path.join(__dirname, '..');

let checks = 0;
function ok(name, fn) {
  fn();
  checks += 1;
  console.log(`  ✓ ${name}`);
}

function base(overrides = {}) {
  return {
    subjectId: 'subject-1',
    subjectName: 'Matemáticas',
    generatedAtIso: '2026-11-26T10:00:00.000Z',
    errors: [],
    blocks: [],
    focus: [],
    outcomes: [],
    topics: [],
    ...overrides,
  };
}

function build(overrides = {}) {
  return coach.buildCoachProfile(base(overrides));
}

function error(rootCause, extra = {}) {
  return { rootCause, isMastered: false, reviewCount: 0, ...extra };
}

function block(status, extra = {}) {
  return {
    status,
    isCompleted: status === 'completada',
    durationMinutes: 25,
    spentMinutes: status === 'completada' ? 25 : 10,
    ...extra,
  };
}

function focus(focusedSeconds, extra = {}) {
  return {
    status: 'completed',
    plannedMinutes: 25,
    focusedSeconds,
    pausedSeconds: 0,
    tutorSeconds: 0,
    interruptions: 0,
    ...extra,
  };
}

function hasSignal(profile, code) {
  return profile.signals.some((signal) => signal.code === code);
}

function hasRecommendation(profile, code) {
  return profile.recommendations.some((recommendation) => recommendation.code === code);
}

console.log('\n  Coach pedagógico y evolución\n');

ok('sin datos no hay diagnóstico ni prompt inventado', () => {
  const profile = build();
  assert.equal(profile.signals.length, 0);
  assert.equal(profile.recommendations.length, 0);
  assert.equal(profile.promptBlock, '');
  assert.equal(profile.rigor, 'equilibrado');
  assert.equal(profile.explanationFocus, 'equilibrado');
  assert.equal(profile.confidence, 'baja');
  assert.match(profile.summary, /sin evidencia suficiente/i);
  assert.equal(profile.evidence.total, 0);
});

ok('detecta un patrón de concepto y refuerza la base', () => {
  const profile = build({ errors: [error('concepto'), error('concepto'), error('concepto'), error('concepto')] });
  assert.equal(hasSignal(profile, 'errores_concepto'), true);
  assert.equal(hasRecommendation(profile, 'reforzar_concepto'), true);
  assert.equal(profile.explanationFocus, 'concepto');
  assert.equal(profile.rigor, 'refuerzo');
  assert.ok(profile.promptBlock.includes('AJUSTE PEDAGÓGICO SILENCIOSO'));
  assert.ok(profile.promptBlock.includes('no lo menciones'));
  assert.ok(!/[<>]/.test(profile.promptBlock));
});

ok('distingue cálculo, lectura y bloqueo', () => {
  const calculo = build({ errors: [error('calculo'), error('calculo'), error('calculo')] });
  assert.equal(hasSignal(calculo, 'errores_calculo'), true);
  assert.equal(calculo.explanationFocus, 'calculo');
  assert.equal(hasRecommendation(calculo, 'exigir_calculo'), true);

  const lectura = build({ errors: [error('lectura_enunciado'), error('lectura_enunciado')] });
  assert.equal(hasSignal(lectura, 'errores_lectura'), true);
  assert.equal(lectura.explanationFocus, 'enunciado');

  const bloqueo = build({ errors: [error('bloqueo'), error('bloqueo')] });
  assert.equal(hasSignal(bloqueo, 'errores_bloqueo'), true);
  assert.equal(hasRecommendation(bloqueo, 'bajar_bloqueo'), true);
});

ok('detecta bloques fallidos sin inventar una tasa con pocos datos', () => {
  const profile = build({
    blocks: [block('completada'), block('completada'), block('abandonada'), block('parcial')],
  });
  assert.equal(hasSignal(profile, 'bloques_fallidos'), true);
  assert.equal(hasRecommendation(profile, 'reducir_bloques'), true);
  assert.equal(profile.explanationFocus, 'habito');

  const one = build({ blocks: [block('abandonada')] });
  assert.equal(hasSignal(one, 'bloques_fallidos'), false);
});

ok('detecta poco tiempo efectivo sin confundirlo con falta de datos', () => {
  const profile = build({
    focus: [focus(300), focus(300), focus(300)],
  });
  assert.equal(hasSignal(profile, 'tiempo_efectivo_bajo'), true);
  assert.equal(hasRecommendation(profile, 'bloques_cortos'), true);
  assert.equal(profile.explanationFocus, 'habito');
  assert.equal(profile.rigor, 'refuerzo');

  const noPlanned = build({
    focus: [focus(0, { plannedMinutes: 0 }), focus(0, { plannedMinutes: 0 })],
  });
  assert.equal(hasSignal(noPlanned, 'tiempo_efectivo_bajo'), false);
});

ok('detecta dependencia del tutor y soluciones directas', () => {
  const dependencia = build({
    focus: [focus(1000, { tutorSeconds: 600 }), focus(1000, { tutorSeconds: 600 })],
  });
  assert.equal(hasSignal(dependencia, 'dependencia_tutor'), true);
  assert.equal(dependencia.explanationFocus, 'autonomia');
  assert.equal(hasRecommendation(dependencia, 'pista_minima'), true);

  const directas = build({
    outcomes: [
      { errorsCreated: 0, directSolutionCount: 1, reviewCardsCreated: 1 },
      { errorsCreated: 0, directSolutionCount: 1, reviewCardsCreated: 1 },
    ],
  });
  assert.equal(hasSignal(directas, 'soluciones_directas'), true);
  assert.equal(hasRecommendation(directas, 'pista_minima'), true);
});

ok('detecta bloques que se alargan y propone ajustar la duración', () => {
  const profile = build({
    blocks: [
      block('completada', { durationMinutes: 25, spentMinutes: 40 }),
      block('completada', { durationMinutes: 25, spentMinutes: 38 }),
    ],
  });
  assert.equal(hasSignal(profile, 'tiempo_subestimado'), true);
  assert.equal(hasRecommendation(profile, 'ajustar_duracion'), true);
  assert.equal(profile.explanationFocus, 'habito');
});

ok('refuerza unidades medidas flojas sin inventar el nivel', () => {
  const profile = build({
    topics: [
      { id: 'u1', title: 'Fracciones', mastery: 30, measured: true },
      { id: 'u2', title: 'Ecuaciones', mastery: 40, measured: true },
      { id: 'u3', title: 'Funciones', mastery: 80, measured: true },
    ],
  });
  assert.equal(hasSignal(profile, 'base_debil'), true);
  assert.equal(hasRecommendation(profile, 'reforzar_base'), true);
  assert.deepEqual(profile.baseTopics, ['Fracciones', 'Ecuaciones']);
  assert.equal(profile.explanationFocus, 'concepto');
});

ok('detecta estancamiento cuando coinciden errores, base floja y bloque fallido', () => {
  const profile = build({
    errors: [
      error('concepto'),
      error('concepto'),
      error('concepto'),
      error('concepto'),
      error('concepto'),
    ],
    topics: [
      { id: 'u1', title: 'Fracciones', mastery: 30, measured: true },
      { id: 'u2', title: 'Ecuaciones', mastery: 35, measured: true },
    ],
    blocks: [block('abandonada')],
  });
  assert.equal(hasSignal(profile, 'estancamiento'), true);
  assert.equal(hasRecommendation(profile, 'romper_estancamiento'), true);
  assert.equal(profile.rigor, 'refuerzo');
  assert.ok(profile.promptBlock.includes('No añadas contenido nuevo'));
});

ok('sin medición pide diagnóstico y no supone un nivel', () => {
  const profile = build({
    topics: [
      { id: 'u1', title: 'Álgebra', mastery: 20, measured: false },
      { id: 'u2', title: 'Geometría', mastery: 20, measured: false },
      { id: 'u3', title: 'Estadística', mastery: 20, measured: false },
    ],
  });
  assert.equal(hasSignal(profile, 'sin_medicion'), true);
  assert.equal(hasRecommendation(profile, 'diagnostico'), true);
  assert.equal(profile.baseTopics.length, 0);
  assert.ok(profile.promptBlock.includes('diagnóstico'));
  assert.ok(!profile.promptBlock.includes('nivel bajo'));
});

ok('usa el agregado del StudentState para errores abiertos', () => {
  const profile = build({
    state: {
      errorsOpen: 5,
      dueReviews: 2,
      units: { total: 10, measured: 4 },
    },
  });
  assert.equal(profile.evidence.errorsOpen, 5);
  assert.equal(profile.evidence.dueReviews, 2);
  assert.equal(hasSignal(profile, 'errores_abiertos'), true);
  assert.equal(hasRecommendation(profile, 'cerrar_errores'), true);
  assert.match(profile.summary, /5 errores abiertos/);
});

ok('no calcula tasas sin denominador real', () => {
  const profile = build({
    errors: [error('concepto')],
    blocks: [block('abandonada')],
    focus: [focus(100)],
  });
  assert.equal(hasSignal(profile, 'bloques_fallidos'), false);
  assert.equal(hasSignal(profile, 'tiempo_efectivo_bajo'), false);
  assert.ok(!profile.promptBlock.includes('%'));
});

ok('el mismo contenido en distinto orden produce el mismo fingerprint', () => {
  const errors = [error('concepto'), error('concepto'), error('calculo'), error('calculo')];
  const blocks = [block('completada'), block('abandonada'), block('completada')];
  const topics = [
    { id: 'u1', title: 'Álgebra', mastery: 30, measured: true },
    { id: 'u2', title: 'Fracciones', mastery: 40, measured: true },
  ];
  const first = build({ errors, blocks, topics });
  const second = build({
    errors: [...errors].reverse(),
    blocks: [...blocks].reverse(),
    topics: [...topics].reverse(),
  });
  assert.equal(first.fingerprint, second.fingerprint);
  assert.deepEqual(first.signals, second.signals);
  assert.deepEqual(first.baseTopics, second.baseTopics);
});

ok('dos materias no comparten recomendaciones ni base', () => {
  const first = build({
    subjectId: 'subject-a',
    subjectName: 'Matemáticas',
    topics: [{ id: 'a1', title: 'Límites', mastery: 25, measured: true }],
  });
  const second = build({
    subjectId: 'subject-b',
    subjectName: 'Física',
    topics: [{ id: 'b1', title: 'Cinemática', mastery: 25, measured: true }],
  });
  assert.notEqual(first.fingerprint, second.fingerprint);
  assert.deepEqual(first.baseTopics, ['Límites']);
  assert.deepEqual(second.baseTopics, ['Cinemática']);
  assert.ok(!first.baseTopics.includes('Cinemática'));
  assert.notEqual(coach.coachScope('subject-a'), coach.coachScope('subject-b'));
  assert.equal(coach.coachScope('subject-a'), 'coach:subject-a');
});

ok('el esquema acepta el perfil real y rechaza HTML inyectado', () => {
  const profile = build({ errors: [error('concepto'), error('concepto')] });
  const parsed = coach.coachProfileSchema.safeParse(profile);
  assert.equal(parsed.success, true);

  const broken = { ...profile, summary: '<script>alert(1)</script>' };
  assert.equal(coach.coachProfileSchema.safeParse(broken).success, false);

  const brokenPrompt = { ...profile, promptBlock: '<svg>no</svg>' };
  assert.equal(coach.coachProfileSchema.safeParse(brokenPrompt).success, false);
});

ok('el prompt del coach no filtra proveedor, modelo ni HTML', () => {
  const profile = build({ errors: [error('concepto'), error('concepto')] });
  assert.ok(profile.promptBlock.length <= 1800);
  assert.ok(!/gemini|groq|openai|anthropic|proveedor|modelo/i.test(profile.promptBlock));
  assert.ok(!/[<>]/.test(profile.promptBlock));
});

ok('el perfil puro no llama a IA y el store aísla por userId', () => {
  const profileSource = fs.readFileSync(path.join(root, 'src', 'lib', 'coach', 'profile.ts'), 'utf8');
  const storeSource = fs.readFileSync(path.join(root, 'src', 'lib', 'coach', 'store.ts'), 'utf8');

  assert.ok(!/runAiText|generateText|fetch\(/.test(profileSource));
  assert.ok(!/runAiText|generateText|fetch\(/.test(storeSource));
  assert.ok(storeSource.includes('db(userId)'));
  assert.ok(storeSource.includes('where: { userId, scope'));
  assert.ok(storeSource.includes('prisma.agentMemory.upsert'));
  assert.ok(storeSource.includes('loadCoachPromptBlock'));
  assert.ok(storeSource.includes('refreshCoachAdvice'));
});

ok('la ruta del tutor lee el coach y lo refresca fuera de la respuesta', () => {
  const route = fs.readFileSync(path.join(root, 'src', 'app', 'api', 'tutor', 'route.ts'), 'utf8');
  const tutor = fs.readFileSync(path.join(root, 'src', 'lib', 'tutor.ts'), 'utf8');

  assert.ok(route.includes('loadCoachPromptBlock'));
  assert.ok(route.includes('refreshCoachAdvice'));
  assert.ok(route.includes('coach: coachBlock'));
  assert.ok(route.includes('refreshCoachAdvice(authUser.id, agent.subjectId'));
  assert.ok(route.includes('defer(async () =>'));
  assert.ok(tutor.includes('coach?: string'));
  assert.ok(tutor.includes('ctx.coach.trim()'));
  assert.ok(tutor.includes('NOTE_PROPOSAL_TAG_INSTRUCTION'));
});

console.log(`\n  ${checks} comprobaciones en verde. Coach pedagógico y evolución.\n`);
