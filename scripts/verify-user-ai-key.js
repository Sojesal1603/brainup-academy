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
const store = require(path.join(outDir, 'ai', 'userKeyStore.js'));
const vault = require(path.join(outDir, 'security', 'vault.js'));
const attempts = require(path.join(outAttempts, 'ai', 'keyAttempts.js'));
const check = require(path.join(outCheck, 'geminiKeyCheck.js'));

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
  } finally {
    await store.deleteUserAiKey(TEST_ACCOUNT, 'gemini').catch(() => undefined);
    await attempts.resetAiKeyAttempts(TEST_ACCOUNT).catch(() => undefined);
  }

  console.log(`\n  ✅ ${checks} comprobaciones en verde\n`);
})().catch((error) => {
  console.error('\n  ❌', error && error.message ? error.message : error, '\n');
  process.exit(1);
});
