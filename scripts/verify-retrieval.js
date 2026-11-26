/**
 * Verificación de la Fase 4: recuperación estricta y contrato de citas.
 *
 * Todo es código puro: no hay base de datos, ni red, ni una sola llamada de IA.
 *
 *   a) Aislamiento total: el corpus de B no aparece al consultar como A, ni
 *      siquiera cuando comparten las mismas palabras.
 *   b) En estudio, una cita inventada, de otra cuenta o con texto que no está
 *      en el fragmento se marca y NO cuenta como cobertura. Sin coincidencias,
 *      la pregunta queda fuera de ámbito y no se contesta con conocimiento general.
 *   c) En curiosidad, el mismo corpus vacío no bloquea la respuesta abierta.
 *   d) El híbrido está apagado por defecto: sin vectores, el modo efectivo es
 *      léxico; con vectores, RRF solo reordena fragmentos de la misma cuenta.
 *
 * Uso: `npm run verify:retrieval`.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { compilaTs } = require('./lib/compilaTs');
const projectRoot = path.join(__dirname, '..');

const outDir = compilaTs(['study/retrieval', 'study/answerContract'], '.tmp-verify-retrieval');
const retrieval = require(path.join(outDir, 'study', 'retrieval.js'));
const answers = require(path.join(outDir, 'study', 'answerContract.js'));

let checks = 0;
function ok(name, fn) {
  fn();
  checks += 1;
  console.log(`  ✓ ${name}`);
}

function chunk(id, userId, text, overrides = {}) {
  return {
    id,
    userId,
    kind: overrides.kind ?? 'note',
    sourceId: overrides.sourceId ?? `src-${userId}`,
    sourceTitle: overrides.sourceTitle ?? `Material de ${userId}`,
    label: overrides.label ?? 'La derivada',
    pageFrom: overrides.pageFrom ?? 1,
    pageTo: overrides.pageTo ?? 1,
    text,
    order: overrides.order ?? 0,
  };
}

const TEXTO_A =
  'La derivada de una función mide la tasa de cambio instantánea. La derivada de x al cuadrado es dos x.';
const TEXTO_B =
  'La derivada de una función mide la tasa de cambio instantánea. El secreto de B es la tortuga 5521.';

const corpus = [
  chunk('a-1', 'alumno-a', TEXTO_A, { sourceTitle: 'Apuntes de A' }),
  chunk('b-1', 'alumno-b', TEXTO_B, { sourceTitle: 'Apuntes de B' }),
];

console.log('\n  RAG estricto: aislamiento, citas y modos\n');

console.log('  1) Aislamiento por cuenta');

const planA = retrieval.selectRetrievalContext({
  userId: 'alumno-a',
  chunks: corpus,
  query: 'derivada tasa de cambio',
  scope: 'estudio',
});

ok('A solo recibe sus fragmentos, nunca los de B', () => {
  assert.equal(planA.chunks.length, 1);
  assert.equal(planA.chunks[0].id, 'a-1');
  assert.equal(planA.allowed.has('b-1'), false);
  assert.match(planA.prompt, /Apuntes de A/);
  assert.doesNotMatch(planA.prompt, /tortuga 5521/);
});

ok('el corpus ajeno no se cuela ni aunque la pregunta coincida', () => {
  const planB = retrieval.selectRetrievalContext({
    userId: 'alumno-b',
    chunks: corpus,
    query: 'derivada tasa de cambio',
    scope: 'estudio',
  });
  assert.deepEqual(planB.chunks.map((item) => item.id), ['b-1']);
  assert.equal(planB.allowed.has('a-1'), false);
});

console.log('\n  2) Contrato de citas en modo estudio');

const citaValida = `La derivada mide la tasa de cambio instantánea. [[cita:a-1|"La derivada de una función mide la tasa de cambio instantánea."]]`;
const valida = answers.validateStudyAnswer({
  raw: citaValida,
  userId: 'alumno-a',
  allowed: planA.allowed,
  meta: planA.chunkMeta,
  retrievedBlocks: planA.retrievedBlocks,
  corpusBlocks: planA.corpusBlocks,
});

ok('una cita literal y del fragmento enviado se verifica y da cobertura', () => {
  assert.equal(valida.meta.verifiedCitations, 1);
  assert.equal(valida.meta.invalidCitations, 0);
  assert.equal(valida.meta.coverage.withCitation, 1);
  assert.equal(valida.meta.coverage.total, 1);
  assert.equal(valida.meta.coverage.ratio, 1);
  assert.equal(valida.meta.status, 'verificado');
  assert.match(valida.markdown, /\[1\]/);
  assert.match(valida.markdown, /Apuntes de A/);
});

const inventada = answers.validateStudyAnswer({
  raw: `La derivada es un límite. [[cita:inventado|"La derivada es un límite."]]`,
  userId: 'alumno-a',
  allowed: planA.allowed,
  meta: planA.chunkMeta,
  retrievedBlocks: planA.retrievedBlocks,
  corpusBlocks: planA.corpusBlocks,
});

ok('un chunkId inventado se rechaza y no cuenta como respaldo', () => {
  assert.equal(inventada.meta.verifiedCitations, 0);
  assert.equal(inventada.meta.invalidCitations, 1);
  assert.equal(inventada.meta.status, 'sin_respaldo');
  assert.match(inventada.markdown, /fuente no verificada/);
  assert.match(inventada.markdown, /Sin respaldo localizable/);
});

ok('un chunkId real de otra cuenta se rechaza en el mismo validador', () => {
  const ajena = answers.validateStudyAnswer({
    raw: `La derivada es un límite. [[cita:b-1|"La derivada de una función mide la tasa de cambio instantánea."]]`,
    userId: 'alumno-a',
    allowed: planA.allowed,
    meta: planA.chunkMeta,
    retrievedBlocks: planA.retrievedBlocks,
    corpusBlocks: planA.corpusBlocks,
  });
  assert.equal(ajena.meta.verifiedCitations, 0);
  assert.equal(ajena.meta.invalidCitations, 1);
});

ok('una cita que no aparece en el texto del fragmento no se publica como verificada', () => {
  const cambiada = answers.validateStudyAnswer({
    raw: `La derivada es un límite. [[cita:a-1|"La derivada de x al cubo es tres x."]]`,
    userId: 'alumno-a',
    allowed: planA.allowed,
    meta: planA.chunkMeta,
    retrievedBlocks: planA.retrievedBlocks,
    corpusBlocks: planA.corpusBlocks,
  });
  assert.equal(cambiada.meta.verifiedCitations, 0);
  assert.equal(cambiada.meta.invalidCitations, 1);
  assert.equal(cambiada.meta.status, 'sin_respaldo');
});

ok('la cobertura verificada se puede guardar y reconstruir sin perder métricas', () => {
  const guardada = answers.parseStudyMeta(JSON.stringify(valida.meta));
  assert.ok(guardada, 'la cobertura válida debería reconstruirse');
  assert.deepEqual(guardada, valida.meta);
  assert.equal(answers.parseStudyMeta('{json roto'), null);
  assert.equal(answers.parseStudyMeta(JSON.stringify({ scope: 'curiosidad' })), null);
});

ok('el sobre JSON del plano se convierte al mismo contrato verificable', () => {
  const raw = JSON.stringify({
    sections: [
      {
        text: 'La derivada mide la tasa de cambio instantánea.',
        citations: [
          {
            chunkId: 'a-1',
            quote: 'La derivada de una función mide la tasa de cambio instantánea.',
          },
        ],
      },
    ],
  });
  const desdeJson = answers.validateStudyAnswer({
    raw,
    userId: 'alumno-a',
    allowed: planA.allowed,
    meta: planA.chunkMeta,
    retrievedBlocks: planA.retrievedBlocks,
    corpusBlocks: planA.corpusBlocks,
  });
  assert.equal(desdeJson.meta.verifiedCitations, 1);
  assert.equal(desdeJson.meta.coverage.withCitation, 1);
  assert.match(desdeJson.markdown, /Apuntes de A/);
});

console.log('\n  3) Fuera de temario y modo curiosidad');

const fuera = retrieval.selectRetrievalContext({
  userId: 'alumno-a',
  chunks: corpus,
  query: 'fotosíntesis de las plantas',
  scope: 'estudio',
});

ok('una pregunta sin coincidencias queda fuera de ámbito ANTES de llamar', () => {
  assert.equal(fuera.outOfScope, true);
  assert.equal(fuera.reason, 'sin_coincidencias');
  assert.equal(fuera.chunks.length, 0);
  assert.equal(fuera.allowed.size, 0);
  const texto = answers.buildStrictOutOfScopeReply(fuera.reason);
  assert.match(texto, /no consta en tu temario/i);
  assert.match(texto, /curiosidad/i);
  assert.doesNotMatch(texto, /\b(gemini|groq|openai|anthropic|gpt|claude)\b/i);
});

ok('sin material indexado tampoco se inventa una respuesta', () => {
  const vacio = retrieval.selectRetrievalContext({
    userId: 'alumno-a',
    chunks: corpus,
    query: 'derivada',
    scope: 'estudio',
  });
  const ajeno = retrieval.selectRetrievalContext({
    userId: 'alumno-sin-material',
    chunks: corpus,
    query: 'derivada',
    scope: 'estudio',
  });
  assert.equal(vacio.outOfScope, false);
  assert.equal(ajeno.outOfScope, true);
  assert.equal(ajeno.reason, 'sin_fuentes');
  assert.match(answers.buildStrictOutOfScopeReply('sin_fuentes'), /no tengo material/i);
});

const curiosidad = retrieval.selectRetrievalContext({
  userId: 'alumno-a',
  chunks: corpus,
  query: 'fotosíntesis de las plantas',
  scope: 'curiosidad',
});

ok('un saludo no se marca fuera de temario ni bloquea el chat', () => {
  assert.equal(retrieval.isConversationalQuery('Hola, ¿qué tal?'), true);
  assert.equal(retrieval.isConversationalQuery('Explícame la fotosíntesis'), false);
  const saludo = retrieval.selectRetrievalContext({
    userId: 'alumno-a',
    chunks: corpus,
    query: 'hola',
    scope: 'estudio',
    allowNoMatch: true,
  });
  assert.equal(saludo.outOfScope, false);
  assert.equal(saludo.chunks.length, 0);
});

ok('en curiosidad no se bloquea por falta de chunks', () => {
  assert.equal(curiosidad.outOfScope, false);
  assert.equal(curiosidad.reason, null);
  assert.equal(curiosidad.chunks.length, 0);
  assert.match(
    answers.buildTutorScopeLayer({ scope: 'curiosidad', hasSources: false, corpusBlocks: 1 }),
    /exploración abierta/i
  );
});

ok('la capa de estudio exige cita y prohíbe completar de memoria', () => {
  const capa = answers.buildTutorScopeLayer({ scope: 'estudio', hasSources: true, corpusBlocks: 3 });
  assert.match(capa, /\[\[cita:/);
  assert.match(capa, /No consta en tu temario/);
  assert.match(capa, /No completes con conocimiento general/);
});

console.log('\n  4) Léxico tolerante: plurales, acentos y sinónimos');

ok('«sustracción» encuentra «resta» sin embeddings', () => {
  const sinonimos = [
    chunk('s-1', 'alumno-a', 'Para resolver una resta se restan los sustraendos.', {
      label: 'La resta',
      sourceTitle: 'Apuntes de aritmética',
    }),
    chunk('s-2', 'alumno-a', 'La fotosíntesis ocurre en los cloroplastos.', {
      label: 'La fotosíntesis',
      sourceTitle: 'Apuntes de biología',
    }),
  ];
  const plan = retrieval.selectRetrievalContext({
    userId: 'alumno-a',
    chunks: sinonimos,
    query: '¿Cómo se hace una sustracción?',
    scope: 'estudio',
  });
  assert.equal(plan.outOfScope, false);
  assert.deepEqual(plan.chunks.map((item) => item.id), ['s-1']);
});

ok('el lematizador básico une plurales y respeta palabras distintas', () => {
  assert.equal(retrieval.canonicalRetrievalTerm('sustracciones'), 'resta');
  assert.equal(retrieval.canonicalRetrievalTerm('restas'), 'resta');
  assert.equal(retrieval.canonicalRetrievalTerm('células'), 'celula');
  assert.equal(retrieval.canonicalRetrievalTerm('funciones'), 'funcion');
  assert.notEqual(retrieval.canonicalRetrievalTerm('fotosintesis'), 'resta');
});

ok('una pregunta sin relación sigue quedando fuera, aunque el léxico sea tolerante', () => {
  const fuera = retrieval.selectRetrievalContext({
    userId: 'alumno-a',
    chunks: corpus,
    query: 'sustracción de polinomios',
    scope: 'estudio',
  });
  assert.equal(fuera.outOfScope, true);
  assert.equal(fuera.reason, 'sin_coincidencias');
});

console.log('\n  5) Léxico por defecto y híbrido opcional');

ok('el híbrido está apagado si no hay vectores', () => {
  delete process.env.RETRIEVAL_MODE;
  assert.equal(retrieval.normalizeRetrievalMode(undefined), 'lexical');
  const plan = retrieval.selectRetrievalContext({
    userId: 'alumno-a',
    chunks: corpus,
    query: 'derivada',
    scope: 'estudio',
    mode: 'hybrid',
  });
  assert.equal(plan.requestedMode, 'hybrid');
  assert.equal(plan.mode, 'lexical');
  assert.equal(plan.chunks.length, 1);
});

ok('con vectores, RRF reordena pero no saca fragmentos de otra cuenta', () => {
  const vectors = new Map([
    ['b-1', 0.99],
    ['a-1', 0.5],
  ]);
  const plan = retrieval.selectRetrievalContext({
    userId: 'alumno-a',
    chunks: corpus,
    query: 'derivada',
    scope: 'estudio',
    mode: 'hybrid',
    vectorScores: vectors,
  });
  assert.equal(plan.mode, 'hybrid');
  assert.deepEqual(plan.chunks.map((item) => item.id), ['a-1']);
  assert.equal(plan.allowed.has('b-1'), false);
});

ok('el troceado de una nota conserva ids deterministas y su dueño', () => {
  const pieces = retrieval.chunksFromNote({
    id: 'nota-1',
    userId: 'alumno-a',
    title: 'Apuntes',
    content: 'La derivada mide la tasa de cambio. '.repeat(80),
  });
  assert.ok(pieces.length >= 1);
  assert.ok(pieces.every((piece) => piece.id.startsWith('note:nota-1:')));
  assert.ok(pieces.every((piece) => piece.userId === 'alumno-a'));
});

console.log('\n  6) Integración real en la ruta y en la interfaz');
const route = fs.readFileSync(path.join(projectRoot, 'src/app/api/tutor/route.ts'), 'utf8');
const chat = fs.readFileSync(path.join(projectRoot, 'src/components/brainup/TutorChat.tsx'), 'utf8');
const page = fs.readFileSync(path.join(projectRoot, 'src/app/brainup/[agentId]/page.tsx'), 'utf8');
const schema = fs.readFileSync(path.join(projectRoot, 'prisma/schema.prisma'), 'utf8');
const migration = fs.readFileSync(
  path.join(projectRoot, 'prisma/migrations/20261126130000_ai_message_study_meta/migration.sql'),
  'utf8'
);

ok('la ruta corta el modo estudio ANTES de llamar al modelo', () => {
  const corte = route.indexOf("scope === 'estudio' && retrievalPlan.outOfScope");
  const llamada = route.indexOf('await runAiText({');
  assert.ok(corte >= 0, 'no está el corte por ámbito');
  assert.ok(llamada >= 0, 'no está la llamada al modelo');
  assert.ok(corte < llamada, 'el corte tiene que ir antes de gastar la llamada');
  assert.match(route, /buildStrictOutOfScopeReply/);
  assert.match(route, /validateStudyAnswer/);
  assert.match(route, /loadSourceChunksForSubject/);
});

ok('la interfaz envía el ámbito y pinta la cobertura verificada', () => {
  assert.match(chat, /scope,\n\s*\/\/ La misma clave/);
  assert.match(chat, />\s*Estudio\s*</);
  assert.match(chat, />\s*Curiosidad\s*</);
  assert.match(chat, /studyMeta\.coverage\.withCitation/);
  assert.match(chat, /Explorar en curiosidad/);
});

ok('la cobertura se guarda con la respuesta y vuelve al recargar', () => {
  assert.match(schema, /studyMetaJson\s+String\?/);
  assert.match(migration, /ADD COLUMN "studyMetaJson" TEXT/);
  assert.match(route, /studyMetaJson: studyMeta \? JSON\.stringify\(studyMeta\)/);
  assert.match(route, /study: parseStudyMeta\(existingReply\.studyMetaJson\)/);
  assert.match(page, /studyMeta: parseStudyMeta\(m\.studyMetaJson\)/);
  assert.match(chat, /lastAssistant\?\.studyMeta \?\? null/);
  assert.match(chat, /studyMeta: data\.study \?\? null/);
});

console.log(`\n  ${checks} comprobaciones en verde. RAG estricto, citas verificadas y cobertura persistida.\n`);
