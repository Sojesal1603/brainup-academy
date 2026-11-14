/**
 * Sondea qué modelos configurados responden de verdad AHORA.
 *
 * El catálogo de Google puede anunciar modelos que luego se quedan colgados o
 * devuelven 503 (pasó con `3.8-flash` y `3.7-flash`): fiarse del listado dejaba
 * al alumno sin respuesta. Este script llama a cada modelo con un prompt mínimo
 * y enseña la tabla real: estado HTTP, milisegundos y qué modelos están
 * excluidos por configuración.
 *
 * No imprime ninguna clave: solo dice si existe y con qué proveedor se prueba.
 *
 * Uso:
 *   node scripts/check-ai-models.js            # todos los proveedores con clave
 *   node scripts/check-ai-models.js gemini     # solo uno
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TIMEOUT_MS = 20_000;

function readEnvFile() {
  const env = {};
  try {
    const text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match) env[match[1]] = match[2].replace(/^["']|["']$/g, '').trim();
    }
  } catch {
    /* sin .env: se usan solo las variables del proceso */
  }
  return env;
}

const fileEnv = readEnvFile();
const env = (name) => String(process.env[name] ?? fileEnv[name] ?? '').trim();

function readConfig() {
  const raw = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'ai', 'models.json'), 'utf8');
  const parsed = JSON.parse(raw);
  const config = {};
  for (const [provider, value] of Object.entries(parsed)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    config[provider] = value;
  }
  return config;
}

const ENV_BY_PROVIDER = {
  gemini: 'AI_GEMINI_MODELS',
  groq: 'AI_GROQ_MODELS',
  openrouter: 'AI_OPENROUTER_MODELS',
  nvidia: 'AI_NVIDIA_MODELS',
};

const KEY_BY_PROVIDER = {
  gemini: ['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
  groq: ['GROQ_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  nvidia: ['NVIDIA_API_KEY'],
};

const allowPreview = /^(1|true|si|sí)$/i.test(env('ALLOW_PREVIEW_MODELS') || '0');

function chainOf(config, provider) {
  const fromEnv = (env(ENV_BY_PROVIDER[provider]) || '')
    .split(/[\s,;]+/)
    .map((id) => id.trim())
    .filter(Boolean);
  const fromFile = Array.isArray(config[provider]?.chain) ? config[provider].chain : [];
  const entries =
    fromEnv.length > 0
      ? fromEnv.map((id) => fromFile.find((entry) => entry.id === id) ?? { id })
      : fromFile;
  const excluded = new Set((config[provider]?.exclude ?? []).map(String));
  return entries.map((entry) => {
    const id = String(entry.id ?? '').trim();
    const preview = entry.preview === true || /preview|experimental/i.test(id);
    return {
      id,
      excluded: excluded.has(id),
      preview,
      allowed: !excluded.has(id) && (!preview || allowPreview),
    };
  });
}

function providerKey(provider) {
  for (const name of KEY_BY_PROVIDER[provider]) {
    const value = env(name);
    if (value) return value;
  }
  return '';
}

async function probe(provider, model, key) {
  const started = Date.now();
  try {
    let response;
    if (provider === 'gemini') {
      response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          model,
          store: false,
          input: [{ type: 'user_input', content: 'Responde solo: ok' }],
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } else {
      const base =
        provider === 'groq'
          ? 'https://api.groq.com/openai/v1'
          : provider === 'openrouter'
            ? 'https://openrouter.ai/api/v1'
            : 'https://integrate.api.nvidia.com/v1';
      response = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Responde solo: ok' }],
          max_tokens: 24,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    }
    const body = await response.json().catch(() => null);
    const state = response.ok ? 'OK' : `HTTP ${response.status}`;
    let note = '';
    const text = response.ok
      ? (body?.output_text ??
        body?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join('') ??
        body?.choices?.[0]?.message?.content ??
        '')
      : (body?.error?.message ?? '');
    if (!response.ok) note = String(note).replace(/\s+/g, ' ');
    note = String(text ?? '').replace(/\s+/g, ' ').slice(0, 60);
    return { state, ms: Date.now() - started, note };
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return {
      state: timedOut ? 'TIMEOUT' : 'ERROR',
      ms: Date.now() - started,
      note: timedOut ? `sin respuesta en ${TIMEOUT_MS / 1000} s` : String(error?.message ?? error),
    };
  }
}

async function main() {
  const only = (process.argv[2] || '').trim().toLowerCase();
  const config = readConfig();
  const providers = ['gemini', 'groq', 'openrouter', 'nvidia'].filter(
    (provider) => !only || provider === only
  );

  console.log(
    `\nModelos configurados · ALLOW_PREVIEW_MODELS=${allowPreview ? '1' : '0'} · ` +
      `timeout ${TIMEOUT_MS / 1000} s\n`
  );
  console.log(
    '  ' +
      'PROVEEDOR'.padEnd(11) +
      'MODELO'.padEnd(40) +
      'ESTADO'.padEnd(11) +
      'MS'.padEnd(8) +
      'POLÍTICA / NOTA'
  );
  console.log('  ' + '-'.repeat(100));

  let failures = 0;
  for (const provider of providers) {
    const key = providerKey(provider);
    const entries = chainOf(config, provider);
    if (entries.length === 0) {
      console.log(`  ${provider.padEnd(11)}(sin modelos configurados)`);
      continue;
    }
    if (!key) {
      for (const entry of entries) {
        console.log(
          `  ${provider.padEnd(11)}${entry.id.padEnd(40)}${'SIN CLAVE'.padEnd(11)}${'—'.padEnd(8)}no se prueba`
        );
      }
      continue;
    }
    for (const entry of entries) {
      if (!entry.allowed) {
        const why = entry.excluded
          ? 'excluido en models.json'
          : 'preview: ALLOW_PREVIEW_MODELS=1 para probarlo';
        console.log(`  ${provider.padEnd(11)}${entry.id.padEnd(40)}${'OMITIDO'.padEnd(11)}${'—'.padEnd(8)}${why}`);
        continue;
      }
      const result = await probe(provider, entry.id, key);
      if (result.state !== 'OK') failures += 1;
      console.log(
        `  ${provider.padEnd(11)}${entry.id.padEnd(40)}${result.state.padEnd(11)}${String(
          result.ms
        ).padEnd(8)}${result.note}`
      );
    }
  }

  console.log(
    `\n  ${failures === 0 ? '✅ todos los modelos probados responden' : `⚠️  ${failures} modelo(s) no responden`}\n`
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('\n  ❌', error?.message ?? error, '\n');
  process.exitCode = 1;
});
