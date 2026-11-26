/**
 * Verificación de la Fase 3: router BYOK dinámico.
 *
 * Demuestra, con `fetch` interceptado y credenciales sintéticas (sin base de
 * datos ni cuotas reales):
 *
 *   a) Cero llamadas a proveedores que el alumno no ha configurado.
 *   b) Respeto al orden de prioridad y filtrado por capacidades (visión/JSON).
 *   c) Mensajes de degradación sin nombres de proveedor ni de modelo.
 *   d) Los tres adaptadores (OpenAI-compatible, Anthropic y Gemini) y el
 *      endpoint propio, más el hedge dentro del perfil.
 *
 * Uso: `npm run verify:router`.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { compilaTs } = require('./lib/compilaTs');

process.env.NODE_ENV = 'test';
process.env.OLLAMA_ENABLED = 'false';
process.env.AI_PROVIDER = 'auto';
process.env.ALLOW_PREVIEW_MODELS = '0';
for (const key of Object.keys(process.env)) {
  if (/(GEMINI|GROQ|OPENROUTER|NVIDIA|OPENAI|ANTHROPIC)_API_KEY/.test(key)) delete process.env[key];
}

const outDir = compilaTs(
  ['aiEngine', 'ai/credentials', 'ai/providers', 'ai/router'],
  '.tmp-verify-router'
);
const engine = require(path.join(outDir, 'aiEngine.js'));
const credentials = require(path.join(outDir, 'ai/credentials.js'));
const providers = require(path.join(outDir, 'ai/providers.js'));
const router = require(path.join(outDir, 'ai/router.js'));

const FORBIDDEN = /\b(gemini|groq|openrouter|nvidia|openai|anthropic|ollama|gpt-?4|claude|llama|qwen)\b/i;

let calls = [];
let chatDelayMs = 0;

function json(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function credential(provider, priority, baseUrl) {
  return {
    provider,
    key: `clave-de-prueba-${provider}`,
    source: 'usuario',
    label: 'principal',
    envVar: 'usuario',
    ledgerId: `prueba:${provider}`,
    priority,
    ...(baseUrl ? { baseUrl } : {}),
  };
}

function firstChatCall(filter = () => true) {
  return calls.find((call) => call.url.includes('/chat/completions') && filter(call));
}

global.fetch = async (url, init = {}) => {
  const target = String(url);
  calls.push({ url: target, init });
  const host = (() => {
    try {
      return new URL(target).host;
    } catch {
      return '';
    }
  })();

  if (host === '127.0.0.1:11434' || host === 'localhost:11434') throw new Error('sin motor local');

  if (target.includes('/models')) {
    if (host.includes('generativelanguage')) {
      return json({ models: [{ name: 'models/gemini-3.5-flash-lite' }] });
    }
    if (host.includes('api.openai.com')) {
      return json({ data: [{ id: 'gpt-4o-mini' }] });
    }
    if (host.includes('api.anthropic.com')) {
      return json({ data: [{ id: 'claude-3-5-haiku-latest' }] });
    }
    return json({ data: [{ id: 'modelo-de-prueba' }] });
  }

  if (target.includes('generativelanguage.googleapis.com')) {
    if (chatDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, chatDelayMs));
    return json({
      steps: [{ type: 'model_output', content: [{ type: 'text', text: 'respuesta de gemini' }] }],
    });
  }

  if (target.includes('/messages')) {
    return json({ content: [{ type: 'text', text: 'respuesta de anthropic' }] });
  }

  if (target.includes('/chat/completions')) {
    if (chatDelayMs > 0 && host.includes('generativelanguage')) {
      await new Promise((resolve) => setTimeout(resolve, chatDelayMs));
    }
    return json({
      choices: [{ message: { role: 'assistant', content: `respuesta de ${host}` }, finish_reason: 'stop' }],
    });
  }

  throw new Error(`URL inesperada: ${target}`);
};

let checks = 0;
function ok(name, fn) {
  fn();
  checks += 1;
  console.log(`  ✓ ${name}`);
}

async function withCredentials(list, work) {
  return credentials.runWithAiCredentials(list, work);
}

(async () => {
  console.log('\n  Router BYOK dinámico\n');

  console.log('  1) Catálogo extensible');

  ok('OpenAI, Anthropic y endpoint propio salen del catálogo', () => {
    assert.equal(providers.getProviderDescriptor('openai').adapter, 'openai-chat');
    assert.equal(providers.getProviderDescriptor('anthropic').adapter, 'anthropic-messages');
    assert.equal(providers.getProviderDescriptor('custom').requiresBaseUrl, true);
    assert.equal(providers.getProviderDescriptor('proveedor-inexistente'), null);
  });

  ok('las capacidades se declaran por modelo, no por proveedor', () => {
    assert.equal(providers.modelCapabilities('openai', 'gpt-4o-mini').vision, true);
    assert.equal(providers.modelCapabilities('groq', 'openai/gpt-oss-120b').vision, false);
    assert.equal(providers.modelCapabilities('anthropic', 'claude-3-5-haiku-latest').json, true);
  });

  ok('un endpoint propio solo admite HTTPS público', () => {
    assert.equal(providers.normalizeProviderBaseUrl('http://api.example.com/v1').ok, false);
    assert.equal(providers.normalizeProviderBaseUrl('https://localhost/v1').ok, false);
    assert.equal(providers.normalizeProviderBaseUrl('https://192.168.1.5/v1').ok, false);
    const good = providers.normalizeProviderBaseUrl('https://api.example.com/v1/');
    assert.equal(good.ok, true);
    assert.equal(good.url, 'https://api.example.com/v1');
  });

  ok('el router elige campeón y hedge solo entre los modelos del perfil', () => {
    const plan = router.planRoute({
      models: [
        { provider: 'groq', model: 'openai/gpt-oss-120b' },
        { provider: 'gemini', model: 'gemini-3.5-flash-lite' },
      ],
      providerOrder: ['gemini', 'groq'],
    });
    assert.equal(plan.champion.provider, 'gemini');
    assert.equal(plan.hedge.provider, 'groq');
  });

  console.log('\n  2) Cero llamadas fuera del perfil');

  calls = [];
  chatDelayMs = 0;
  await withCredentials([credential('groq', 0)], async () => {
    const result = await engine.runAiText({
      systemInstruction: 'Eres un catedrático.',
      message: 'Explícame la derivada.',
    });
    assert.equal(result.provider, 'groq');
    const outside = calls.filter((call) => {
      try {
        return new URL(call.url).host !== 'api.groq.com';
      } catch {
        return true;
      }
    });
    assert.deepEqual(outside.map((call) => call.url), []);
  });
  ok('solo se llama al proveedor configurado (Groq)', () => {
    assert.ok(firstChatCall());
  });

  console.log('\n  3) Orden del alumno y adaptadores');

  calls = [];
  await withCredentials(
    [credential('groq', 0), credential('gemini', 1)],
    async () => {
      const result = await engine.runAiText({
        systemInstruction: 'x',
        message: 'hola',
      });
      assert.equal(result.provider, 'groq');
    }
  );
  ok('la prioridad del alumno pone Groq delante de Gemini', () => {
    const first = calls.find(
      (call) => call.url.includes('/chat/completions') || call.url.includes('/interactions')
    );
    assert.ok(first, 'no hubo llamada de chat');
    assert.ok(first.url.includes('api.groq.com'), first.url);
  });

  calls = [];
  await withCredentials([credential('anthropic', 0)], async () => {
    const result = await engine.runAiText({ systemInstruction: 'x', message: 'hola' });
    assert.equal(result.provider, 'anthropic');
    assert.equal(result.text, 'respuesta de anthropic');
  });
  ok('el adaptador Anthropic usa /messages y x-api-key, no el dialecto OpenAI', () => {
    const call = calls.find((entry) => entry.url.includes('/messages'));
    assert.ok(call, 'no se llamó a /messages');
    assert.equal(call.init.headers['x-api-key'], 'clave-de-prueba-anthropic');
    assert.equal(call.init.headers['anthropic-version'], '2023-06-01');
    assert.equal(calls.some((entry) => entry.url.includes('/chat/completions')), false);
  });

  calls = [];
  await withCredentials([credential('openai', 0)], async () => {
    const result = await engine.runAiText({ systemInstruction: 'x', message: 'hola' });
    assert.equal(result.provider, 'openai');
  });
  ok('OpenAI entra como una entrada de catálogo, sin ramas nuevas', () => {
    const call = firstChatCall();
    assert.ok(call && call.url.startsWith('https://api.openai.com/v1/chat/completions'), call?.url);
  });

  calls = [];
  await withCredentials([credential('custom', 0, 'https://api.example.com/v1')], async () => {
    const result = await engine.runAiText({ systemInstruction: 'x', message: 'hola' });
    assert.equal(result.provider, 'custom');
  });
  ok('el endpoint propio usa la baseUrl HTTPS validada de esa cuenta', () => {
    const call = firstChatCall();
    assert.ok(call && call.url.startsWith('https://api.example.com/v1/chat/completions'), call?.url);
  });

  console.log('\n  4) Capacidades y degradación neutra');

  calls = [];
  let visionError = null;
  await withCredentials([credential('groq', 0)], async () => {
    try {
      await engine.runAiText({
        systemInstruction: 'x',
        message: 'mira esta foto',
        attachments: [{ name: 'foto.png', mimeType: 'image/png', data: 'AAAA' }],
      });
    } catch (error) {
      visionError = error;
    }
  });
  ok('sin visión, se avisa ANTES de enviar la imagen', () => {
    assert.ok(visionError, 'no lanzó error');
    assert.equal(visionError.status, 422);
    assert.equal(calls.some((call) => call.url.includes('/chat/completions')), false);
    assert.doesNotMatch(visionError.message, FORBIDDEN);
    assert.match(visionError.message, /imágenes|texto/i);
  });

  calls = [];
  let jsonError = null;
  await withCredentials([credential('custom', 0, 'https://api.example.com/v1')], async () => {
    try {
      await engine.runAiText({
        systemInstruction: 'x',
        message: 'devuelve JSON',
        requiresJson: true,
      });
    } catch (error) {
      jsonError = error;
    }
  });
  ok('sin JSON, se degrada antes de gastar la llamada', () => {
    assert.ok(jsonError);
    assert.equal(jsonError.status, 422);
    assert.equal(calls.some((call) => call.url.includes('/chat/completions')), false);
    assert.doesNotMatch(jsonError.message, FORBIDDEN);
    assert.match(jsonError.message, /estructurada/i);
  });

  console.log('\n  5) Hedge dentro del perfil');

  calls = [];
  chatDelayMs = 900;
  const t0 = Date.now();
  await withCredentials(
    [credential('gemini', 0), credential('groq', 1)],
    async () => {
      const result = await engine.runAiText({
        systemInstruction: 'x',
        message: 'hola',
        budgetMs: 5_000,
      });
      assert.equal(result.provider, 'groq');
    }
  );
  const elapsed = Date.now() - t0;
  chatDelayMs = 0;
  ok('el hedge gana cuando el campeón tarda, sin salir del perfil', () => {
    assert.ok(elapsed < 2_500, `tardó ${elapsed} ms`);
    const hosts = new Set(
      calls
        .map((call) => {
          try {
            return new URL(call.url).host;
          } catch {
            return '';
          }
        })
        .filter((host) => host && !host.includes('generativelanguage'))
    );
    for (const host of hosts) {
      assert.ok(
        host === 'api.groq.com' || host === 'generativelanguage.googleapis.com',
        `host fuera del perfil: ${host}`
      );
    }
  });

  console.log(`\n  ${checks} comprobaciones en verde. Router BYOK dentro del perfil.\n`);
})().catch((error) => {
  console.error('\n  ✗ La verificación del router ha fallado:\n');
  console.error(error);
  process.exit(1);
});
