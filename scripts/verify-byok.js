/**
 * Verificación de la Fase 0 del contrato BYOK.
 *
 * Comprueba, con DOS cuentas sintéticas reales y un proveedor simulado:
 *
 *   a) Aislamiento por cuenta. Un 429 (cupo) o un 401 (clave inválida) del
 *      Alumno A no enfría, no bloquea ni contamina los contadores del Alumno B.
 *      Incluye el «último modelo bueno», que antes era una variable global.
 *   b) Perfil resuelto solo con las claves del alumno y caché de 60 s con
 *      invalidación inmediata al guardar o borrar una clave.
 *
 * No gasta cuota: `fetch` está interceptado y responde con dobles. No toca
 * cuentas reales: crea dos `UserProfile` con UUID aleatorios y los borra en el
 * `finally` (las claves caen por cascada).
 *
 * Uso: `npm run verify:byok`
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { loadEnv } = require('./lib/loadEnv');
const { compilaTs } = require('./lib/compilaTs');

loadEnv();

if (!process.env.SECRETS_KEY_V1) {
  console.error('Falta SECRETS_KEY_V1 en .env: sin vault no se pueden guardar claves.');
  process.exit(1);
}

/*
 * Entorno controlado antes de compilar/cargar el motor:
 * - nadie usa la clave de plataforma (los sentinelas no deben aparecer);
 * - no se sondea Ollama (red local);
 * - el proveedor se fuerza en cada escenario para que la cadena sea determinista.
 */
process.env.PLATFORM_AI_USER_IDS = '';
process.env.BRAINUP_AI_TEST_MODE = '0';
process.env.OLLAMA_ENABLED = 'false';
process.env.AI_PROVIDER = 'gemini';
delete process.env.GEMINI_MODEL;
delete process.env.GROQ_MODEL;

const outDir = compilaTs(
  ['aiEngine', 'ai/credentials', 'ai/userKeyStore', 'ai/profileCache', 'ai/ledgerId'],
  '.tmp-verify-byok'
);
const engine = require(path.join(outDir, 'aiEngine.js'));
const credentials = require(path.join(outDir, 'ai', 'credentials.js'));
const store = require(path.join(outDir, 'ai', 'userKeyStore.js'));
const profileCache = require(path.join(outDir, 'ai', 'profileCache.js'));
const ledger = require(path.join(outDir, 'ai', 'ledgerId.js'));

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const ALUMNO_A = randomUUID();
const ALUMNO_B = randomUUID();

const KEYS = {
  aGemini: 'AIzaSy-BYOK-A-GEMINI-0001',
  aGeminiNueva: 'AIzaSy-BYOK-A-GEMINI-0002',
  aGroq: 'gsk_BYOK_A_GROQ_000000000001',
  bGemini: 'AIzaSy-BYOK-B-GEMINI-0001',
  bGroq: 'gsk_BYOK_B_GROQ_000000000001',
};

const PLATFORM_SENTINEL = 'PLATFORM-KEY-DO-NOT-USE';

let checks = 0;
async function ok(name, fn) {
  await fn();
  checks += 1;
  console.log(`  ✓ ${name}`);
}

function json(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  };
}

/** Llamadas reales al proveedor (sin contar el catálogo de modelos). */
let calls = [];

/**
 * Proveedor simulado. Cada clave tiene un comportamiento fijo:
 * - gemini de A → 429 (cupo agotado)
 * - gemini de B → respuesta correcta
 * - groq de A  → 401 (clave inválida)
 * - groq de B  → respuesta correcta
 */
global.fetch = async (url, options = {}) => {
  const target = String(url);
  const headers = options.headers || {};

  // Catálogo: el motor lo consulta antes de armar la cadena. Se responde con la
  // forma de Gemini y la de Groq/OpenAI a la vez.
  if (target.includes('/models')) {
    return json({
      models: [
        { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
      ],
      data: [{ id: 'openai/gpt-oss-120b' }],
    });
  }

  if (headers['x-goog-api-key']) {
    const key = headers['x-goog-api-key'];
    calls.push({ provider: 'gemini', key });
    if (key === KEYS.aGemini || key === KEYS.aGeminiNueva) {
      return json({ error: { message: 'You exceeded your current quota' } }, 429);
    }
    return json({
      steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Respuesta de B con Gemini.' }] }],
    });
  }

  const authorization = String(headers.Authorization || headers.authorization || '');
  const key = authorization.replace(/^Bearer\s+/, '');
  calls.push({ provider: 'groq', key });
  if (key === KEYS.aGroq) {
    return json({ error: { message: 'API key not valid. Please pass a valid API key.' } }, 401);
  }
  return json({
    choices: [{ message: { content: 'Respuesta de B con Groq.' }, finish_reason: 'stop' }],
  });
};

/** Ejecuta un turno con las credenciales de una cuenta y captura el error. */
async function turno(profileCredentials, params) {
  modelCallsStart = calls.length;
  let result = null;
  let error = null;
  const warn = console.warn;
  console.warn = () => {};
  try {
    result = await credentials.runWithAiCredentials(profileCredentials, () =>
      engine.runAiText({
        systemInstruction: 'Eres un tutor.',
        message: 'Explícame la derivada de x².',
        ...params,
      })
    );
  } catch (caught) {
    error = caught;
  } finally {
    console.warn = warn;
  }
  return { result, error, calls: calls.slice(modelCallsStart) };
}

let modelCallsStart = 0;

(async () => {
  console.log('\n  Contrato BYOK: aislamiento por cuenta y caché del perfil\n');

  try {
    console.log('  1) Dos cuentas sintéticas y sus claves');
    await prisma.userProfile.create({
      data: { id: ALUMNO_A, name: 'Verificación BYOK A (temporal)' },
    });
    await prisma.userProfile.create({
      data: { id: ALUMNO_B, name: 'Verificación BYOK B (temporal)' },
    });

    await store.saveUserAiKey({
      userId: ALUMNO_A,
      provider: 'gemini',
      key: KEYS.aGemini,
      status: 'valida',
      lastError: null,
    });
    await store.saveUserAiKey({
      userId: ALUMNO_A,
      provider: 'groq',
      key: KEYS.aGroq,
      status: 'valida',
      lastError: null,
    });
    await store.saveUserAiKey({
      userId: ALUMNO_B,
      provider: 'gemini',
      key: KEYS.bGemini,
      status: 'valida',
      lastError: null,
    });
    await store.saveUserAiKey({
      userId: ALUMNO_B,
      provider: 'groq',
      key: KEYS.bGroq,
      status: 'valida',
      lastError: null,
    });

    profileCache.clearAiProfileCache();
    console.log('     (cuentas y claves listas; la caché arranca vacía)');

    await ok('cada cuenta tiene un ledgerId distinto, estable y sin datos en claro', () => {
      const ledgerA = ledger.accountLedgerId(ALUMNO_A, 'gemini');
      const ledgerA2 = ledger.accountLedgerId(ALUMNO_A, 'gemini');
      const ledgerB = ledger.accountLedgerId(ALUMNO_B, 'gemini');
      assert.equal(ledgerA, ledgerA2, 'el ledger debe ser determinista en el proceso');
      assert.notEqual(ledgerA, ledgerB, 'dos alumnos no pueden compartir libro');
      assert.notEqual(ledgerA, 'usuario');
      assert.ok(!ledgerA.includes(ALUMNO_A), 'el ledger no puede contener el userId');
      assert.ok(!ledgerA.includes(KEYS.aGemini), 'el ledger no puede contener la clave');
    });

    console.log('\n  2) El perfil usa SOLO las claves del alumno');

    const perfilA1 = await credentials.resolveUserAiProfile(ALUMNO_A);
    const perfilB1 = await credentials.resolveUserAiProfile(ALUMNO_B);

    await ok('A recibe exactamente sus dos proveedores, sin claves de plataforma', () => {
      assert.deepEqual(
        perfilA1.credentials.map((credential) => credential.provider).sort(),
        ['gemini', 'groq']
      );
      assert.ok(perfilA1.credentials.every((credential) => credential.source === 'usuario'));
      assert.ok(perfilA1.credentials.every((credential) => credential.key !== PLATFORM_SENTINEL));
      assert.equal(perfilA1.fromCache, false);
    });

    await ok('B recibe sus claves y un libro distinto al de A', () => {
      const ledgerA = ledger.accountLedgerId(ALUMNO_A, 'gemini');
      const ledgerB = ledger.accountLedgerId(ALUMNO_B, 'gemini');
      assert.deepEqual(
        perfilB1.credentials.map((credential) => credential.provider).sort(),
        ['gemini', 'groq']
      );
      assert.ok(perfilB1.credentials.every((credential) => credential.source === 'usuario'));
      assert.ok(perfilB1.credentials.every((credential) => credential.ledgerId !== ledgerA));
      assert.ok(perfilB1.credentials.some((credential) => credential.ledgerId === ledgerB));
      assert.ok(perfilB1.credentials.every((credential) => credential.envVar === 'usuario'));
    });

    await ok('aunque A esté autorizado a plataforma, sus claves propias mandan solas', async () => {
      process.env.PLATFORM_AI_USER_IDS = ALUMNO_A;
      process.env.GEMINI_API_KEY = PLATFORM_SENTINEL;
      // Sin limpiar la caché: se comprueba que la política se aplica en vivo.
      const perfil = await credentials.resolveUserAiProfile(ALUMNO_A);
      assert.ok(perfil.credentials.length > 0);
      assert.ok(perfil.credentials.every((credential) => credential.source === 'usuario'));
      assert.ok(perfil.credentials.every((credential) => credential.key !== PLATFORM_SENTINEL));
      process.env.PLATFORM_AI_USER_IDS = '';
      delete process.env.GEMINI_API_KEY;
    });

    console.log('\n  3) Caché del perfil e invalidación exacta');

    const perfilA2 = await credentials.resolveUserAiProfile(ALUMNO_A);
    const perfilB2 = await credentials.resolveUserAiProfile(ALUMNO_B);

    await ok('la segunda resolución seguida sale de caché (coste cero de base)', () => {
      assert.equal(perfilA2.fromCache, true);
      assert.equal(perfilB2.fromCache, true);
      assert.equal(profileCache.aiProfileCacheSize(), 2);
    });

    await ok('guardar una clave nueva invalida SOLO la caché de esa cuenta', async () => {
      await store.saveUserAiKey({
        userId: ALUMNO_A,
        provider: 'gemini',
        key: KEYS.aGeminiNueva,
        status: 'valida',
        lastError: null,
      });
      const perfilA3 = await credentials.resolveUserAiProfile(ALUMNO_A);
      const perfilB3 = await credentials.resolveUserAiProfile(ALUMNO_B);
      const geminiA = perfilA3.credentials.find((credential) => credential.provider === 'gemini');

      assert.equal(perfilA3.fromCache, false, 'A debe releer al cambiar su clave');
      assert.equal(geminiA.key, KEYS.aGeminiNueva);
      assert.equal(perfilB3.fromCache, true, 'la caché de B no se toca');
      assert.equal(
        perfilB3.credentials.find((credential) => credential.provider === 'gemini').key,
        KEYS.bGemini
      );
    });

    await ok('la caché barre las claves caducadas de cuentas inactivas', () => {
      profileCache.clearAiProfileCache();
      // Entrada que caduca en el instante 60 000 y escritura posterior en 120 000.
      profileCache.writeCachedOwnKeys('cuenta-inactiva', new Map([['gemini', 'k']]), 1, 0);
      profileCache.writeCachedOwnKeys('cuenta-activa', new Map([['gemini', 'k']]), 1, 120_000);
      assert.equal(profileCache.readCachedOwnKeys('cuenta-inactiva', 120_000), null);
      assert.equal(profileCache.aiProfileCacheSize(), 1);
      profileCache.clearAiProfileCache();
    });

    console.log('\n  4) Aislamiento real: A con 429 y con 401, B intacto');

    process.env.AI_PROVIDER = 'gemini';
    calls = [];
    const perfilA = await credentials.resolveUserAiProfile(ALUMNO_A);
    const perfilB = await credentials.resolveUserAiProfile(ALUMNO_B);
    const ledgerAGemini = perfilA.credentials.find((c) => c.provider === 'gemini').ledgerId;
    const ledgerBGemini = perfilB.credentials.find((c) => c.provider === 'gemini').ledgerId;

    const turnoA = await turno(perfilA.credentials, {});
    const modeloQueFallo = engine.getLastDecision().attempts[0].key.split('#')[0];

    await ok('el turno de A termina en 429 sin bloquear ni tocar a B', () => {
      assert.equal(turnoA.error?.status, 429);
      assert.ok(turnoA.calls.length > 0);
      assert.ok(turnoA.calls.every((call) => call.key === KEYS.aGeminiNueva));
      assert.ok(
        engine.getPairCooldownSeconds(modeloQueFallo, ledgerAGemini) > 0,
        'el modelo agotado debe enfriarse para A'
      );
      assert.equal(
        engine.getPairCooldownSeconds(modeloQueFallo, ledgerBGemini),
        0,
        'el mismo modelo sigue libre para B'
      );
      assert.ok(engine.getKeyCallCount('gemini', ledgerAGemini) > 0);
      assert.equal(engine.getKeyCallCount('gemini', ledgerBGemini), 0);
    });

    calls = [];
    const turnoB = await turno(perfilB.credentials, {});

    await ok('B responde a la primera con SU clave, sin heredar el enfriamiento', () => {
      assert.equal(turnoB.error, null);
      assert.equal(turnoB.result.text, 'Respuesta de B con Gemini.');
      assert.deepEqual(turnoB.calls.map((call) => call.key), [KEYS.bGemini]);
      assert.ok(engine.getPairCooldownSeconds(`gemini:${turnoB.result.model}`, ledgerBGemini) === 0);
      assert.ok(engine.getKeyCallCount('gemini', ledgerBGemini) > 0);
    });

    await ok('el «último modelo bueno» es de cada cuenta, no global', () => {
      const ultimoB = credentials.runWithAiCredentials(perfilB.credentials, () =>
        engine.getLastGoodKey()
      );
      const ultimoA = credentials.runWithAiCredentials(perfilA.credentials, () =>
        engine.getLastGoodKey()
      );
      assert.equal(ultimoB, `gemini:${turnoB.result.model}`);
      assert.equal(ultimoA, null, 'A nunca respondió: no puede heredar el acierto de B');
    });

    process.env.AI_PROVIDER = 'groq';
    calls = [];
    const ledgerAGroq = perfilA.credentials.find((c) => c.provider === 'groq').ledgerId;
    const ledgerBGroq = perfilB.credentials.find((c) => c.provider === 'groq').ledgerId;

    const turnoAGroq = await turno(perfilA.credentials, {});
    await ok('una clave inválida (401) de A enfría solo el libro de A', () => {
      assert.ok(turnoAGroq.error);
      assert.ok(engine.getKeyCooldownSeconds('groq', ledgerAGroq) > 0);
      assert.equal(engine.getKeyCooldownSeconds('groq', ledgerBGroq), 0);
    });

    calls = [];
    const turnoBGroq = await turno(perfilB.credentials, {});
    await ok('B sigue pudiendo usar Groq con su propia clave', () => {
      assert.equal(turnoBGroq.error, null);
      assert.equal(turnoBGroq.result.text, 'Respuesta de B con Groq.');
      assert.deepEqual(turnoBGroq.calls.map((call) => call.key), [KEYS.bGroq]);
      assert.ok(engine.getKeyCooldownSeconds('groq', ledgerBGroq) === 0);
    });

    console.log('\n  5) Borrar una clave también invalida la caché');

    await ok('tras borrar, el perfil deja de ofrecer ese proveedor en el acto', async () => {
      await store.deleteUserAiKey(ALUMNO_A, 'groq');
      const perfilA4 = await credentials.resolveUserAiProfile(ALUMNO_A);
      assert.equal(perfilA4.fromCache, false);
      assert.deepEqual(perfilA4.ownProviders, ['gemini']);
      assert.ok(perfilA4.credentials.every((credential) => credential.provider === 'gemini'));
    });

    await ok('borrar la última clave deja el perfil vacío (sin caer a plataforma)', async () => {
      await store.deleteUserAiKey(ALUMNO_A, 'gemini');
      const perfilA5 = await credentials.resolveUserAiProfile(ALUMNO_A);
      assert.equal(perfilA5.credentials.length, 0);
      assert.deepEqual(perfilA5.ownProviders, []);
    });

    console.log(`\n  ${checks} comprobaciones en verde. BYOK aislado y cacheado.\n`);
  } catch (error) {
    console.error('\n  ✗ La verificación BYOK ha fallado:\n');
    console.error(error);
    process.exitCode = 1;
  } finally {
    calls = [];
    profileCache.clearAiProfileCache();
    // Las claves caen por cascada al borrar los perfiles sintéticos.
    await prisma.userProfile
      .deleteMany({ where: { id: { in: [ALUMNO_A, ALUMNO_B] } } })
      .catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    process.env.AI_PROVIDER = 'auto';
  }
})();
