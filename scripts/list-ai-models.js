/**
 * Muestra el catálogo real de modelos que tu clave permite, con los mismos
 * filtros de política que aplica el motor de BrainUp (sin "pro" de pago, sin
 * modelos de imagen/audio experimentales).
 *
 * El ranking definitivo con puntuaciones y enfriamientos en vivo se ve en
 * http://localhost:3000/ajustes.
 *
 * Uso: node scripts/list-ai-models.js   (o npm run ai:models)
 */
const fs = require('fs');
const path = require('path');

function readEnv(name) {
  if (process.env[name]) return String(process.env[name]).trim();
  try {
    const env = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
    const match = env.match(new RegExp(`^${name}=(.*)$`, 'm'));
    return match ? match[1].replace(/['"]/g, '').trim() : '';
  } catch {
    return '';
  }
}

/** Misma política que src/lib/aiEngine.ts: fuera pago, imagen, audio, preview. */
const GEMINI_VETO =
  /pro|image|tts|live|audio|omni|lyria|nano|banana|robotics|computer-use|deep-research|embedding|preview|experimental|antigravity|2\.5|2\.0|1\.5|1\.0/i;

function geminiScore(name) {
  const flashLite = name.match(/^gemini-(\d+)\.(\d+)-flash-lite$/);
  if (flashLite) return 9000 + Number(flashLite[1]) * 100 + Number(flashLite[2]) * 10 + 1;
  const flash = name.match(/^gemini-(\d+)\.(\d+)-flash$/);
  if (flash) return 10000 + Number(flash[1]) * 100 + Number(flash[2]) * 10 + 5;
  const gemma = name.match(/^gemma-(\d+)-(\d+)b(-a\d+b)?-it$/);
  if (gemma) return 5000 + Number(gemma[1]) * 100 + Number(gemma[2]);
  if (name === 'gemini-flash-latest') return 4000;
  if (name === 'gemini-flash-lite-latest') return 3900;
  return null;
}

function groqScore(name) {
  if (/whisper|tts|guard|audio|vision|embedding|preview/i.test(name)) return null;
  const oss = name.match(/^openai\/gpt-oss-(\d+)b$/);
  if (oss) return 12000 + Number(oss[1]) / 10;
  const llama = name.match(/^llama-(\d+)\.(\d+)-(\d+)b(-instant|-versatile)?$/);
  if (llama) {
    return 10000 + Number(llama[1]) * 100 + Number(llama[2]) * 10 + Number(llama[3]);
  }
  if (name.startsWith('qwen/')) return 7000;
  if (name.startsWith('moonshotai/')) return 6500;
  return null;
}

function report(provider, listed, score, veto) {
  const usable = [];
  const vetoed = [];

  for (const name of listed) {
    if (veto && veto.test(name)) {
      vetoed.push(name);
      continue;
    }
    const value = score(name);
    if (value === null) continue;
    usable.push({ name, score: value });
  }

  usable.sort((a, b) => b.score - a.score);

  console.log(`\n=== ${provider} (${usable.length} modelos en la rotación automática) ===`);
  for (const entry of usable) {
    console.log(`  ${String(entry.score).padStart(6)}  ${entry.name}`);
  }
  if (vetoed.length > 0) {
    console.log(`  (${vetoed.length} modelos vetados por política: pago, imagen, audio, experimental…)`);
  }
}

async function listGemini() {
  const key = readEnv('GEMINI_API_KEY') || readEnv('GOOGLE_API_KEY');
  if (!key) {
    console.log('\n=== Gemini: sin clave configurada (GEMINI_API_KEY) ===');
    return;
  }

  const res = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200',
    { headers: { 'x-goog-api-key': key } }
  );
  console.log(`\nGemini: HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) {
    console.log('  Error de la API:', data.error.status, '-', data.error.message);
    return;
  }

  const listed = (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => String(m.name || '').replace(/^models\//, ''));

  report('Gemini', listed, geminiScore, GEMINI_VETO);
}

async function listGroq() {
  const key = readEnv('GROQ_API_KEY');
  if (!key) {
    console.log(
      '\n=== Groq: sin clave configurada (GROQ_API_KEY) — proveedor de respaldo opcional ==='
    );
    return;
  }

  const res = await fetch('https://api.groq.com/openai/v1/models', {
    headers: { Authorization: `Bearer ${key}` },
  });
  console.log(`\nGroq: HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) {
    console.log('  Error de la API:', data.error.message);
    return;
  }

  const listed = (data.data || []).map((m) => String(m.id || ''));
  report('Groq', listed, groqScore, null);
}

(async () => {
  await listGemini();
  await listGroq();
  console.log(
    '\nBrainUp usa el primero de cada lista que esté disponible y sano; el ranking en vivo está en /ajustes.\n'
  );
})();
