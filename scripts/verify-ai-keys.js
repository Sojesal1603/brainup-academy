/**
 * Verificación de la política de credenciales de IA (paso 0).
 *
 * Comprueba lo que de verdad importa:
 *   - un usuario sin clave y fuera de PLATFORM_AI_USER_IDS no obtiene ninguna
 *     credencial y la ruta devuelve 402 `ai_key_required`;
 *   - la clave de plataforma solo se entrega a los ids de la lista;
 *   - el motor no llama a ningún proveedor sin un ámbito de credenciales;
 *   - con una clave de usuario, la petición viaja con ESA clave y nunca con la
 *     de plataforma;
 *   - la clave no aparece en el estado del motor ni en los mensajes;
 *   - `src/` no lee claves de IA fuera de `src/lib/ai/credentials.ts`;
 *   - todas las rutas de IA pasan por la puerta `ensureAiAccess`.
 *
 * Uso: `node scripts/verify-ai-keys.js`
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { compilaTs, projectRoot } = require('./lib/compilaTs');
const { loadEnv } = require('./lib/loadEnv');

// Prisma se usa para comprobar que la cuenta de prueba no tiene clave propia;
// el script necesita la misma conexión que la app.
loadEnv();

// Dueño sintético: las pruebas no deben depender de que la cuenta real tenga o
// no una clave guardada (cambiaría el resultado de «usa la de plataforma»).
const OWNER = '11111111-1111-4111-8111-111111111111';
const STRANGER = '3af632ee-22dc-4e75-85a8-139aa70600bf';

// Entorno de plataforma simulado. Las claves son señuelos: si alguna llega a una
// petición de un usuario que no es el dueño, el test falla.
process.env.PLATFORM_AI_USER_IDS = OWNER;
process.env.GEMINI_API_KEY = 'PLATFORM-GEMINI-DO-NOT-USE';
process.env.GROQ_API_KEY = 'PLATFORM-GROQ-DO-NOT-USE';
process.env.BRAINUP_AI_TEST_MODE = '0';
process.env.OLLAMA_ENABLED = 'false';

// Una sola compilación para el motor y la puerta: comparten el módulo de
// credenciales (y su `AsyncLocalStorage`), igual que dentro de la app. Con
// carpetas distintas, `enterWith` en una no se vería en la otra.
const engineOut = compilaTs(['aiEngine', 'ai/access'], '.tmp-verify-ai-keys');
const engine = require(path.join(engineOut, 'aiEngine.js'));
const credentials = require(path.join(engineOut, 'ai', 'credentials.js'));
const access = require(path.join(engineOut, 'ai', 'access.js'));

let checks = 0;
async function ok(name, fn) {
  await fn();
  checks += 1;
  console.log(`  ✓ ${name}`);
}

async function rejectsWith402(fn) {
  let caught = null;
  try {
    await fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, 'debía lanzar AiKeyRequiredError');
  assert.equal(caught.code, 'ai_key_required', caught.code);
  assert.equal(caught.status, 402, String(caught.status));
  assert.ok(!/PLATFORM-/.test(caught.message), 'el mensaje no filtra la clave');
  return caught;
}

function spyFetch() {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), headers: options.headers || {}, body: options.body || '' });
    throw new Error('no se debe llamar al proveedor');
  };
  return {
    calls,
    restore() {
      global.fetch = original;
    },
  };
}

(async () => {
  console.log('\n  Credenciales de IA\n');

  await ok('el usuario de la lista se resuelve a la clave de plataforma', async () => {
    const owner = await credentials.resolveAiCredentials(OWNER, 'gemini');
    assert.equal(owner.source, 'plataforma');
    assert.equal(owner.key, process.env.GEMINI_API_KEY);
    assert.equal(credentials.isPlatformAiUser(OWNER), true);
  });

  await rejectsWith402(() => credentials.resolveAiCredentials(STRANGER, 'gemini'));
  checks += 1;
  console.log('  ✓ un usuario fuera de la lista no obtiene credencial');

  await ok('un usuario sin clave resuelve una lista vacía (la ruta decide el 402)', async () => {
    assert.deepEqual(await credentials.resolveAllAiCredentials(STRANGER), []);
  });

  await ok('ensureAiAccess devuelve HTTP 402 con el código ai_key_required', async () => {
    const gate = await access.ensureAiAccess(STRANGER);
    assert.ok(gate.denied, 'debía devolver una respuesta');
    assert.equal(gate.denied.status, 402);
    assert.deepEqual(gate.credentials, [], 'un rechazo no entrega credenciales');
    const body = await gate.denied.json();
    assert.equal(body.code, 'ai_key_required');
    assert.equal(body.ok, false);
    assert.ok(!/PLATFORM-/.test(JSON.stringify(body)), 'la respuesta filtra la clave');
  });

  await ok('sin ámbito de petición el motor no llama a nadie', async () => {
    const spy = spyFetch();
    try {
      await rejectsWith402(() =>
        engine.runAiText({ systemInstruction: 'x', message: 'hola' })
      );
      assert.deepEqual(await credentials.resolveAllAiCredentials(STRANGER), []);
    } finally {
      spy.restore();
    }
    assert.equal(spy.calls.length, 0, `${spy.calls.length} petición(es) al proveedor`);
  });

  await ok('un ámbito vacío tampoco gasta la clave de plataforma', async () => {
    const spy = spyFetch();
    try {
      await rejectsWith402(() =>
        credentials.runWithAiCredentials([], () =>
          engine.runAiText({ systemInstruction: 'x', message: 'hola' })
        )
      );
    } finally {
      spy.restore();
    }
    assert.equal(spy.calls.length, 0, `${spy.calls.length} petición(es) al proveedor`);
  });

  await ok('con clave de usuario se usa ESA y jamás la de plataforma', async () => {
    const seen = [];
    const original = global.fetch;
    global.fetch = async (url, options = {}) => {
      seen.push({ url: String(url), headers: options.headers || {}, body: options.body || '' });
      if (String(url).includes('/models')) {
        return {
          ok: true,
          json: async () => ({
            models: [
              {
                name: 'models/gemini-1.5-flash',
                supportedGenerationMethods: ['generateContent'],
              },
            ],
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          steps: [{ type: 'model_output', content: [{ type: 'text', text: 'respuesta de prueba' }] }],
        }),
      };
    };
    const userKey = 'USER-OWN-KEY-123456';
    const scoped = [
      {
        provider: 'gemini',
        key: userKey,
        source: 'usuario',
        label: 'principal',
        envVar: 'usuario',
      },
    ];
    try {
      const result = await credentials.runWithAiCredentials(scoped, () =>
        engine.runAiText({ systemInstruction: 'x', message: 'hola' })
      );
      assert.equal(result.provider, 'gemini');
      assert.equal(result.text, 'respuesta de prueba');

      const serialized = JSON.stringify(seen);
      assert.ok(!serialized.includes(process.env.GEMINI_API_KEY), 'se filtró la clave de plataforma');
      assert.ok(!serialized.includes(process.env.GROQ_API_KEY), 'se filtró la clave de Groq');
      assert.ok(
        seen.every(
          (call) => call.url.includes('/models') || call.headers['x-goog-api-key'] === userKey
        ),
        'la llamada de generación no llevó la clave del usuario'
      );

      const status = await credentials.runWithAiCredentials(scoped, () =>
        engine.getEngineStatus()
      );
      assert.ok(!JSON.stringify(status).includes(userKey), 'la clave aparece en el estado');
    } finally {
      global.fetch = original;
    }
  });

  await ok(
    'con clave propia de Gemini y Gemini caído no se toca ningún proveedor de plataforma',
    async () => {
      /** Toda petición queda apuntada: ninguna debe salir hacia otro proveedor. */
      const seen = [];
      const original = global.fetch;
      global.fetch = async (url) => {
        const target = String(url);
        seen.push(target);
        if (target.includes('/models')) {
          return {
            ok: true,
            json: async () => ({
              models: [
                { name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent'] },
              ],
            }),
          };
        }
        return {
          ok: false,
          status: 503,
          json: async () => ({ error: { message: 'high demand' } }),
        };
      };
      const ownGemini = [
        {
          provider: 'gemini',
          key: 'USER-GEMINI-ONLY-KEY',
          source: 'usuario',
          label: 'principal',
          envVar: 'usuario',
        },
      ];
      let caught = null;
      try {
        await credentials.runWithAiCredentials(ownGemini, () =>
          engine.runAiText({ systemInstruction: 'x', message: 'hola' })
        );
      } catch (error) {
        caught = error;
      } finally {
        global.fetch = original;
      }
      assert.ok(caught, 'Gemini caído debía terminar en error, no en respuesta inventada');
      assert.notEqual(caught.code, 'ai_key_required', 'la clave propia existe: no es un 402');
      assert.ok(
        /Gemini|IA/i.test(caught.message) && !/PLATFORM-/.test(caught.message),
        `mensaje poco claro: ${caught.message}`
      );
      const foreign = seen.filter((url) =>
        /api\.groq\.com|integrate\.api\.nvidia\.com|openrouter\.ai/i.test(url)
      );
      assert.deepEqual(foreign, [], `se llamó a otro proveedor: ${foreign.join(', ')}`);
      assert.ok(seen.length > 0, 'la prueba no ejercitó ninguna petición');
      assert.ok(
        seen.every((url) => /generativelanguage\.googleapis\.com/.test(url)),
        `salió una petición que no era de Gemini: ${seen.join(', ')}`
      );
    }
  );

  await ok(
    'con clave propia de Groq y Gemini de plataforma, la petición solo va a Groq',
    async () => {
      const seen = [];
      const original = global.fetch;
      global.fetch = async (url) => {
        const target = String(url);
        seen.push(target);
        if (target.includes('/models')) {
          return { ok: true, json: async () => ({ data: [{ id: 'openai/gpt-oss-120b' }] }) };
        }
        return {
          ok: true,
          json: async () => ({ choices: [{ message: { content: 'respuesta de groq' } }] }),
        };
      };
      const ownGroq = [
        {
          provider: 'groq',
          key: 'USER-GROQ-ONLY-KEY',
          source: 'usuario',
          label: 'principal',
          envVar: 'usuario',
        },
      ];
      let result = null;
      try {
        result = await credentials.runWithAiCredentials(ownGroq, () =>
          engine.runAiText({ systemInstruction: 'x', message: 'hola' })
        );
      } finally {
        global.fetch = original;
      }
      assert.equal(result.provider, 'groq');
      assert.ok(seen.length > 0, 'la prueba no ejercitó ninguna petición');
      const foreign = seen.filter((url) => !/api\.groq\.com/.test(url));
      assert.deepEqual(foreign, [], `se llamó fuera de Groq: ${foreign.join(', ')}`);
    }
  );

  await ok('src/ solo lee claves de IA en credentials.ts', () => {
    const keyRead =
      /process\.env(?:\.|\s*\[\s*['"])(?:GEMINI|GROQ|OPENROUTER|NVIDIA)_API_KEY(?:_[2-4])?|process\.env(?:\.|\s*\[\s*['"])GOOGLE_(?:GENERATIVE_AI|GENAI|API)_KEY/;
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        const relative = path.relative(projectRoot, full).replace(/\\/g, '/');
        if (relative === 'src/lib/ai/credentials.ts') continue;
        if (keyRead.test(fs.readFileSync(full, 'utf8'))) offenders.push(relative);
      }
    };
    walk(path.join(projectRoot, 'src'));
    assert.deepEqual(offenders, []);
  });

  await ok('todas las rutas de IA pasan por ensureAiAccess', () => {
    const routes = [
      'src/app/api/tutor/route.ts',
      'src/app/api/tutor/notes/route.ts',
      'src/app/api/tutor/tools/route.ts',
      'src/app/api/notebooklm/transform/route.ts',
      'src/app/api/puesta-a-punto/route.ts',
      'src/app/api/examinador/start/route.ts',
      'src/app/api/examinador/submit/route.ts',
      'src/app/api/examinador/foto/route.ts',
      'src/app/api/examinador/evaluacion/route.ts',
    ];
    for (const route of routes) {
      const source = fs.readFileSync(path.join(projectRoot, route), 'utf8');
      assert.ok(source.includes('ensureAiAccess'), `${route} no llama a ensureAiAccess`);
      // La puerta solo resuelve: el ámbito tiene que activarlo la ruta en su
      // propio marco o el motor se queda sin proveedores (bug del catedrático).
      assert.ok(
        source.includes('activateAiCredentials'),
        `${route} no activa las credenciales en su marco`
      );
      assert.ok(
        !/process\.env\.(?:GEMINI|GROQ|OPENROUTER|NVIDIA)_API_KEY/.test(source),
        `${route} lee una clave de IA del entorno`
      );
    }
  });

  /*
   * REGRESIÓN DEL CATEDRÁTICO.
   *
   * La puerta devolvía la respuesta 402 o `null` y activaba el ámbito dentro de
   * su propia función. `AsyncLocalStorage.enterWith` no propaga al llamante, así
   * que la ruta seguía sin credenciales: con clave válida, el motor contestaba
   * «no hay ningún proveedor» y el chat caía al respaldo local. Aquí se comprueba
   * el patrón correcto —resolver y activar en el mismo marco— y que el ámbito
   * sigue vivo después de un `await`, como en una ruta real.
   */
  await ok('la puerta deja el ámbito activo en el marco que la llama', async () => {
    const gate = await access.ensureAiAccess(OWNER);
    assert.equal(gate.denied, null, 'el dueño de plataforma tiene credenciales');
    assert.ok(gate.credentials.length > 0, 'la puerta no devolvió credenciales');
    access.activateAiCredentials(gate.credentials);
    await new Promise((resolve) => setTimeout(resolve, 1));
    const providers = engine.getConfiguredProviders();
    assert.ok(providers.includes('gemini'), `sin Gemini tras la puerta: ${providers.join(', ')}`);
    assert.ok(engine.hasAiProvider(), 'hasAiProvider() falso teniendo clave');
  });

  console.log(`\n  ✅ ${checks} comprobaciones en verde\n`);
})().catch((error) => {
  console.error('\n  ❌', error && error.message ? error.message : error, '\n');
  process.exit(1);
});
