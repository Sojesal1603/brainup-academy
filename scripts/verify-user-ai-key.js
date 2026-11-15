/**
 * Verificación de la clave de IA propia (pasos 1–3).
 *
 * Usa la cuenta de prueba real para el almacén (crea y borra su fila) y
 * comprueba:
 *   - el sobre guardado es `v1.iv.tag.ct`, no contiene la clave y cambia de IV;
 *   - se descifra con el mismo userId y falla con otro (AAD);
 *   - el estado y los últimos 4 se leen sin el sobre;
 *   - borrar deja la cuenta sin clave;
 *   - el límite de intentos corta al sexto;
 *   - la validación contra Google sanea los errores (no filtra clave ni URL);
 *   - `UserAiKey` tiene RLS y ni anon ni authenticated tienen grants.
 *
 * Uso: `node scripts/verify-user-ai-key.js`
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadEnv } = require('./lib/loadEnv');
const { compilaTs } = require('./lib/compilaTs');

loadEnv();

const OWNER = '16bb4958-5288-493b-8c65-379dd31782f5';
const TEST_ACCOUNT = '3af632ee-22dc-4e75-85a8-139aa70600bf';
const FAKE_KEY = 'AIzaSy-FAKE-USER-KEY-1234567890';

if (!process.env.SECRETS_KEY_V1) {
  console.error('Falta SECRETS_KEY_V1 en .env');
  process.exit(1);
}

const outDir = compilaTs('ai/userKeyStore', '.tmp-verify-user-ai-key');
const outAttempts = compilaTs('ai/keyAttempts', '.tmp-verify-user-attempts');
const outCheck = compilaTs('ai/geminiKeyCheck', '.tmp-verify-user-check');
const outFormat = compilaTs('ai/keyFormat', '.tmp-verify-user-format');
const outCreds = compilaTs('ai/credentials', '.tmp-verify-user-creds');
const store = require(path.join(outDir, 'ai', 'userKeyStore.js'));
const vault = require(path.join(outDir, 'security', 'vault.js'));
const attempts = require(path.join(outAttempts, 'ai', 'keyAttempts.js'));
const check = require(path.join(outCheck, 'geminiKeyCheck.js'));
const keyFormat = require(path.join(outFormat, 'keyFormat.js'));
const creds = require(path.join(outCreds, 'ai', 'credentials.js'));

let checks = 0;
async function ok(name, fn) {
  await fn();
  checks += 1;
  console.log(`  ✓ ${name}`);
}

(async () => {
  console.log('\n  Clave de IA propia\n');

  try {
    await store.deleteUserAiKey(TEST_ACCOUNT, 'gemini').catch(() => undefined);

    await ok('acepta claves de Google con punto (AQ.) y rechaza espacios o controles', () => {
      assert.equal(keyFormat.aiKeyFormatError('AQ.Ab8RN6Example_Key-123'), null);
      assert.equal(keyFormat.aiKeyFormatError('AIzaSy-Example_Key.123'), null);
      assert.match(keyFormat.aiKeyFormatError('AIza clave con espacio'), /sin espacios/i);
      assert.match(keyFormat.aiKeyFormatError('AIza\nclave'), /sin espacios/i);
      assert.match(keyFormat.aiKeyFormatError('AIza/clave'), /puntos/i);
    });

    await ok('el formato vale para los cuatro proveedores y google es gemini', () => {
      const groqKey = `gsk_${'a'.repeat(30)}`;
      const openRouterKey = `sk-or-v1-${'b'.repeat(30)}`;
      const nvidiaKey = `nvapi-${'c'.repeat(30)}`;
      for (const [provider, key] of [
        ['gemini', 'AIzaSy-Example_Key.123'],
        ['groq', groqKey],
        ['openrouter', openRouterKey],
        ['nvidia', nvidiaKey],
      ]) {
        assert.equal(keyFormat.providerKeyFormatError(provider, key), null, provider);
      }
      assert.match(keyFormat.providerKeyFormatError('groq', 'gsk clave con espacio'), /sin espacios/i);
      assert.match(keyFormat.providerKeyFormatError('nvidia', 'nvapi'), /demasiado corta/i);
      assert.equal(keyFormat.normalizeUserKeyProvider('google'), 'gemini');
      assert.equal(keyFormat.normalizeUserKeyProvider('GOOGLE'), 'gemini');
      assert.equal(keyFormat.normalizeUserKeyProvider('groq'), 'groq');
      assert.equal(keyFormat.normalizeUserKeyProvider('openai'), null);
      assert.equal(keyFormat.normalizeUserKeyProvider(''), null);
    });

    await ok('el formulario y el servidor comparten la misma regla de formato', () => {
      const fs = require('node:fs');
      const path = require('node:path');
      const { projectRoot } = require('./lib/compilaTs');
      for (const relative of ['src/app/ajustes/aiKeyActions.ts', 'src/components/ajustes/AiKeyCard.tsx']) {
        const source = fs.readFileSync(path.join(projectRoot, relative), 'utf8');
        assert.ok(source.includes('keyFormat'), `${relative} no usa la regla compartida`);
        assert.ok(!/A-Za-z0-9_-\]/.test(source), `${relative} conserva la regla antigua sin punto`);
      }
    });

    await ok('guardar cifra la clave y no la deja en claro', async () => {
      const summary = await store.saveUserAiKey({
        userId: TEST_ACCOUNT,
        provider: 'gemini',
        key: FAKE_KEY,
        status: 'valida',
        lastError: null,
      });
      assert.equal(summary.last4, FAKE_KEY.slice(-4));

      const parties = store;
      assert.ok(parties);
      const { PrismaClient } = require('@prisma/client');
      const prisma = new PrismaClient();
      try {
        const row = await prisma.userAiKey.findUnique({
          where: { userId_provider: { userId: TEST_ACCOUNT, provider: 'gemini' } },
        });
        assert.ok(row, 'no se ha guardado la fila');
        assert.ok(row.ciphertext.startsWith('v1.'), row.ciphertext.slice(0, 3));
        assert.equal(row.ciphertext.split('.').length, 4);
        assert.ok(!row.ciphertext.includes(FAKE_KEY), 'la clave está en claro');
        assert.ok(!JSON.stringify(row).includes(FAKE_KEY), 'la clave está en la fila');
      } finally {
        await prisma.$disconnect();
      }
    });

    await ok('descifra con el mismo userId y falla con otro userId o provider (AAD)', async () => {
      assert.equal(await store.readDecryptedUserKey(TEST_ACCOUNT, 'gemini'), FAKE_KEY);

      const { PrismaClient } = require('@prisma/client');
      const prisma = new PrismaClient();
      try {
        const row = await prisma.userAiKey.findUnique({
          where: { userId_provider: { userId: TEST_ACCOUNT, provider: 'gemini' } },
        });
        for (const aad of [OWNER, store.userAiKeyAad(TEST_ACCOUNT, 'groq')]) {
          let caught = null;
          try {
            vault.decryptSecret(row.ciphertext, aad);
          } catch (error) {
            caught = error;
          }
          assert.ok(caught, 'otro AAD no debe descifrar la clave');
          assert.equal(caught.code, 'vault_decrypt_failed');
        }
      } finally {
        await prisma.$disconnect();
      }
    });

    await ok('una fila antigua (AAD userId) se migra al leerla sin perder la clave', async () => {
      const { PrismaClient } = require('@prisma/client');
      const prisma = new PrismaClient();
      try {
        const legacy = vault.encryptSecret(FAKE_KEY, TEST_ACCOUNT);
        await prisma.userAiKey.update({
          where: { userId_provider: { userId: TEST_ACCOUNT, provider: 'gemini' } },
          data: { ciphertext: legacy },
        });
        assert.equal(await store.readDecryptedUserKey(TEST_ACCOUNT, 'gemini'), FAKE_KEY);
        const migrated = await prisma.userAiKey.findUnique({
          where: { userId_provider: { userId: TEST_ACCOUNT, provider: 'gemini' } },
        });
        assert.equal(
          vault.decryptSecret(migrated.ciphertext, store.userAiKeyAad(TEST_ACCOUNT, 'gemini')),
          FAKE_KEY
        );
      } finally {
        await prisma.$disconnect();
      }
    });

    await ok('el estado enseña solo los últimos 4 y la fecha', async () => {
      const summary = await store.readUserAiKeySummary(TEST_ACCOUNT, 'gemini');
      assert.equal(summary.status, 'valida');
      assert.equal(summary.last4, FAKE_KEY.slice(-4));
      assert.ok(summary.lastCheckedAt);
      assert.ok(!JSON.stringify(summary).includes(FAKE_KEY));
    });

    await ok('dos guardados del mismo texto usan IV distinto', async () => {
      const { PrismaClient } = require('@prisma/client');
      const prisma = new PrismaClient();
      try {
        const before = await prisma.userAiKey.findUnique({
          where: { userId_provider: { userId: TEST_ACCOUNT, provider: 'gemini' } },
        });
        await store.saveUserAiKey({
          userId: TEST_ACCOUNT,
          provider: 'gemini',
          key: FAKE_KEY,
          status: 'valida',
          lastError: null,
        });
        const after = await prisma.userAiKey.findUnique({
          where: { userId_provider: { userId: TEST_ACCOUNT, provider: 'gemini' } },
        });
        assert.notEqual(before.ciphertext.split('.')[1], after.ciphertext.split('.')[1]);
      } finally {
        await prisma.$disconnect();
      }
    });

    await ok('el límite corta al sexto intento y se reinicia al acertar', async () => {
      await attempts.resetAiKeyAttempts(TEST_ACCOUNT);
      for (let index = 0; index < 5; index++) {
        assert.equal((await attempts.consumeAiKeyAttempt(TEST_ACCOUNT)).ok, true, `intento ${index + 1}`);
      }
      const blocked = await attempts.consumeAiKeyAttempt(TEST_ACCOUNT);
      assert.equal(blocked.ok, false);
      assert.ok(blocked.retryAfterSeconds > 0);
      await attempts.resetAiKeyAttempts(TEST_ACCOUNT);
      assert.equal((await attempts.consumeAiKeyAttempt(TEST_ACCOUNT)).ok, true);
    });

    await ok('la validación sanea 401 (ni clave ni URL en el mensaje)', async () => {
      const original = global.fetch;
      global.fetch = async () => ({ ok: false, status: 401 });
      try {
        const result = await check.checkGeminiKey(FAKE_KEY);
        assert.equal(result.status, 'invalida');
        assert.equal(result.persist, true);
        assert.ok(!String(result.error).includes(FAKE_KEY));
        assert.ok(!/https?:\/\//.test(String(result.error)));
      } finally {
        global.fetch = original;
      }
    });

    await ok('429 se guarda como sin_cuota y un fallo de red no pisa la clave', async () => {
      const original = global.fetch;
      global.fetch = async () => ({ ok: false, status: 429 });
      try {
        assert.equal((await check.checkGeminiKey(FAKE_KEY)).status, 'sin_cuota');
      } finally {
        global.fetch = original;
      }

      global.fetch = async () => {
        throw new Error(`fallo de red hacia https://generativelanguage.googleapis.com con ${FAKE_KEY}`);
      };
      try {
        const result = await check.checkGeminiKey(FAKE_KEY);
        assert.equal(result.status, 'sin_comprobar');
        assert.equal(result.persist, false);
        assert.ok(!String(result.error).includes(FAKE_KEY));
        assert.ok(!String(result.error).includes('generativelanguage'));
      } finally {
        global.fetch = original;
      }
    });

    await ok('los intentos de más de 24 h se borran y los recientes se quedan', async () => {
      const { PrismaClient } = require('@prisma/client');
      const prisma = new PrismaClient();
      try {
        await prisma.aiKeyAttempt.deleteMany({ where: { userId: TEST_ACCOUNT } });
        const old = await prisma.aiKeyAttempt.create({
          data: { userId: TEST_ACCOUNT, attemptedAt: new Date(Date.now() - 25 * 60 * 60_000) },
        });
        const recent = await prisma.aiKeyAttempt.create({
          data: { userId: TEST_ACCOUNT, attemptedAt: new Date(Date.now() - 60_000) },
        });
        // El barrido se hace como mucho una vez por hora: se le pasa un reloj
        // dos horas por delante para que esta comprobación no dependa de si ya
        // había barrido antes en este proceso.
        const borrados = await attempts.pruneOldAiKeyAttempts(new Date(Date.now() + 2 * 60 * 60_000));
        assert.ok(borrados >= 1, `no borró nada (${borrados})`);
        const quedan = await prisma.aiKeyAttempt.findMany({
          where: { id: { in: [old.id, recent.id] } },
          select: { id: true },
        });
        assert.deepEqual(
          quedan.map((row) => row.id),
          [recent.id],
          'el barrido debía quitar el de 25 h y dejar el de hace un minuto'
        );
        await prisma.aiKeyAttempt.deleteMany({ where: { userId: TEST_ACCOUNT } });
      } finally {
        await prisma.$disconnect();
      }
    });

    await ok('AiKeyAttempt tiene RLS y cero grants para anon/authenticated', async () => {
      const { PrismaClient } = require('@prisma/client');
      const prisma = new PrismaClient();
      try {
        for (const table of ['UserAiKey', 'AiKeyAttempt']) {
          const [rls] = await prisma.$queryRawUnsafe(
            `SELECT relrowsecurity FROM pg_class WHERE relname = '${table}'`
          );
          assert.equal(rls.relrowsecurity, true, `${table} sin RLS`);
          const [grants] = await prisma.$queryRawUnsafe(
            `SELECT count(*)::int AS n FROM information_schema.role_table_grants
             WHERE table_name = '${table}' AND grantee IN ('anon', 'authenticated')`
          );
          assert.equal(grants.n, 0, `${table} con grants públicos`);
        }
      } finally {
        await prisma.$disconnect();
      }
    });

    await ok('borrar deja la cuenta sin clave', async () => {
      await store.deleteUserAiKey(TEST_ACCOUNT, 'gemini');
      assert.equal(await store.readDecryptedUserKey(TEST_ACCOUNT, 'gemini'), null);
      assert.equal(await store.readUserAiKeySummary(TEST_ACCOUNT, 'gemini'), null);
    });

    /*
     * AISLAMIENTO ENTRE PROVEEDORES.
     *
     * La cuenta de prueba está (simulada) en `PLATFORM_AI_USER_IDS` y tiene
     * señuelos de plataforma de los cuatro proveedores. Con UNA clave propia de
     * Groq, el resolver debe entregar solo esa y no completar Gemini, OpenRouter
     * ni NVIDIA con las de plataforma: el alumno gasta lo que pega.
     */
    await ok('con clave propia no se entregan claves de plataforma de otros proveedores', async () => {
      const envNames = ['PLATFORM_AI_USER_IDS', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY'];
      const before = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
      process.env.PLATFORM_AI_USER_IDS = TEST_ACCOUNT;
      process.env.GEMINI_API_KEY = 'PLATFORM-DECOY-GEMINI';
      process.env.GROQ_API_KEY = 'PLATFORM-DECOY-GROQ';
      process.env.OPENROUTER_API_KEY = 'PLATFORM-DECOY-OPENROUTER';
      process.env.NVIDIA_API_KEY = 'PLATFORM-DECOY-NVIDIA';
      const ownGroq = `gsk_propia_${'d'.repeat(30)}`;
      try {
        await store.saveUserAiKey({
          userId: TEST_ACCOUNT,
          provider: 'groq',
          key: ownGroq,
          status: 'valida',
          lastError: null,
        });

        const all = await creds.resolveAllAiCredentials(TEST_ACCOUNT);
        assert.deepEqual(
          all.map((entry) => `${entry.provider}:${entry.source}`),
          ['groq:usuario'],
          `se entregaron credenciales de más: ${all.map((entry) => entry.provider).join(', ')}`
        );
        assert.ok(all.every((entry) => !entry.key.startsWith('PLATFORM-DECOY')));

        let caught = null;
        try {
          await creds.resolveAiCredentials(TEST_ACCOUNT, 'gemini');
        } catch (error) {
          caught = error;
        }
        assert.ok(caught, 'Gemini no tiene clave propia y no debe resolver');
        assert.equal(caught.code, 'ai_key_required');
        assert.ok(
          !String(caught.message).includes('PLATFORM-DECOY'),
          'el mensaje filtra la clave de plataforma'
        );
      } finally {
        await store.deleteUserAiKey(TEST_ACCOUNT, 'groq').catch(() => undefined);
        for (const name of envNames) {
          if (before[name] === undefined) delete process.env[name];
          else process.env[name] = before[name];
        }
      }
    });
  } finally {
    await store.deleteUserAiKey(TEST_ACCOUNT, 'gemini').catch(() => undefined);
    await attempts.resetAiKeyAttempts(TEST_ACCOUNT).catch(() => undefined);
  }

  console.log(`\n  ✅ ${checks} comprobaciones en verde\n`);
})().catch((error) => {
  console.error('\n  ❌', error && error.message ? error.message : error, '\n');
  process.exit(1);
});
