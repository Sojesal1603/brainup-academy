#!/usr/bin/env node
/**
 * ¿Puede este ordenador llevar los catedráticos por sí solo?
 *
 * Gemini y Groq son gratis pero **tienen cupo** y un día de estudio intenso lo
 * agota (Google cuenta 20 peticiones al día en su modelo grande, por clave). El
 * motor local (Ollama) es lo único que no tiene techo, así que este chequeo
 * responde a la pregunta que importa: ¿mi ordenador lo mueve, y con qué modelo?
 *
 * Lo que hace, en orden:
 *   1. **Mira la máquina de verdad** (RAM total y libre, núcleos, sistema): las
 *      recomendaciones salen de tus números, no de una lista fija.
 *   2. **Comprueba si Ollama está instalado y levantado**, y qué modelos tiene.
 *   3. **Recomienda un modelo** para tu memoria, con su tamaño de descarga.
 *   4. **Lo mide**: si hay servidor, manda un turno corto y cronometra. Lo que se
 *      ve aquí es lo que tardará el respaldo cuando la nube se seque.
 *   5. **Dice el paso siguiente exacto** (instalar, descargar) y en qué afecta a
 *      la app. Ella sola lo detecta: no hay que tocar nada.
 *
 * Uso:
 *   npm run ollama:doctor            → chequeo completo (no descarga nada)
 *   npm run ollama:doctor -- --pull  → además descarga el modelo que recomienda
 *   npm run ollama:doctor -- --model qwen3.5:4b   → mide ese modelo en concreto
 *
 * Sale con código 0 si el motor local está listo para usarse y 1 si no: así
 * sirve también como comprobación automática, no solo como informe.
 */

const os = require('node:os');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const BASE = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/+$/, '');
const args = process.argv.slice(2);
const shouldPull = args.includes('--pull');
const forcedModel = args.includes('--model') ? args[args.indexOf('--model') + 1] : '';

const green = (text) => `\u001b[32m${text}\u001b[0m`;
const yellow = (text) => `\u001b[33m${text}\u001b[0m`;
const red = (text) => `\u001b[31m${text}\u001b[0m`;
const dim = (text) => `\u001b[2m${text}\u001b[0m`;

/** El .env del proyecto, para saber qué tiene configurado la app. */
function readEnv() {
  const file = path.join(process.cwd(), '.env');
  if (!fs.existsSync(file)) return {};
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    env[match[1]] = match[2].replace(/^['"]|['"]$/g, '').trim();
  }
  return env;
}

/**
 * Un modelo para cada tamaño de ordenador.
 *
 * `minGb` es la memoria que conviene tener para que el modelo quepa **con el
 * resto de la app y el navegador abiertos** (que es como se estudia de verdad).
 * El tamaño es el de la descarga, no el de la memoria en marcha.
 */
const CATALOG = [
  {
    minGb: 32,
    model: 'qwen3.5:9b',
    download: '~7,6 GB',
    why: 'Con 32 GB tienes de sobra para el 9B: escribe mejor y aguanta temas largos.',
  },
  {
    minGb: 16,
    model: 'qwen3.5:9b',
    download: '~7,6 GB',
    why: 'El 9B es el mejor equilibrio entre calidad y peso para memoria de 16 GB.',
  },
  {
    minGb: 8,
    model: 'qwen3.5:4b',
    download: '~4,0 GB',
    why: 'Con 8–16 GB, un 4B va fino: explica en español y aguanta bien física y matemáticas.',
  },
  {
    minGb: 4,
    model: 'qwen3:1.7b',
    download: '~1,4 GB',
    why: 'Poca memoria: un modelo pequeño contesta rápido y no te dejará la app colgada.',
  },
  {
    minGb: 0,
    model: 'llama3.2:1b',
    download: '~1,3 GB',
    why: 'El más ligero que existe: sirve para no quedarte sin respuesta, con menos profundidad.',
  },
];

function recommend(totalGb, freeGb) {
  // Se recomienda por la memoria que se puede usar DE VERDAD: si tiene 16 GB pero
  // solo quedan 5 libres (navegador, IDE, todo abierto), un 9B se arrastraría.
  const usableGb = Math.max(freeGb, totalGb * 0.5);
  return CATALOG.find((entry) => usableGb >= entry.minGb) ?? CATALOG[CATALOG.length - 1];
}

function commandExists(command, args2 = ['--version']) {
  try {
    const output = execFileSync(command, args2, { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, output: output.trim().split('\n')[0] };
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) };
  }
}

async function listModels() {
  try {
    const res = await fetch(`${BASE}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}`, models: [] };
    const data = await res.json();
    const models = Array.isArray(data.models) ? data.models : [];
    return { ok: true, models };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error), models: [] };
  }
}

/** Un turno corto de verdad, cronometrado: la única prueba de que va. */
async function measure(model) {
  const startedAt = Date.now();
  try {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: 'En dos frases, en español: ¿por qué una derivada mide una tasa de cambio?',
          },
        ],
        max_tokens: 160,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const ms = Date.now() - startedAt;
    if (!res.ok) return { ok: false, ms, reason: `HTTP ${res.status}` };
    const data = await res.json();
    const text = String(data?.choices?.[0]?.message?.content || '').trim();
    const words = text.split(/\s+/).filter(Boolean).length;
    return { ok: text.length > 0, ms, text, words, perSecond: ms > 0 ? Math.round((words / ms) * 1000 * 10) / 10 : 0 };
  } catch (error) {
    return { ok: false, ms: Date.now() - startedAt, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Cómo se instala, según el sistema. */
function installCommand() {
  if (process.platform === 'win32') return 'irm https://ollama.com/install.ps1 | iex   (en PowerShell)';
  return 'curl -fsSL https://ollama.com/install.sh | sh';
}

async function main() {
  console.log('\n=== Chequeo del motor local (Ollama) ===\n');

  // 1. La máquina.
  const totalGb = os.totalmem() / 1024 ** 3;
  const freeGb = os.freemem() / 1024 ** 3;
  const cpus = os.cpus();
  const cpuName = cpus[0]?.model ?? 'desconocida';
  const cores = cpus.length;

  console.log('1) Tu ordenador');
  console.log(`   Sistema:  ${process.platform} ${os.arch()} · ${os.release()}`);
  console.log(`   CPU:      ${cpuName} (${cores} núcleos)`);
  console.log(`   Memoria:  ${totalGb.toFixed(1)} GB en total, ${freeGb.toFixed(1)} GB libres ahora mismo`);

  const pick = recommend(totalGb, freeGb);
  console.log(
    `   ${green('Recomendación:')} ${pick.model} ${dim(`(${pick.download})`)} · ${pick.why}`
  );
  if (cores < 4) {
    console.log(
      `   ${yellow('Aviso:')} con ${cores} núcleos, el modelo local irá lento. Úsalo como red de seguridad, no como motor principal.`
    );
  }

  // 2. ¿Está instalado?
  console.log('\n2) ¿Está instalado Ollama?');
  const version = commandExists('ollama');
  if (version.ok) {
    console.log(`   ${green('Sí')} · ${version.output}`);
  } else {
    console.log(`   ${red('No')} (no encuentro el comando «ollama» en el PATH)`);
    console.log(`   Para instalarlo:  ${installCommand()}`);
    console.log(dim('   Después, reinicia la terminal para que el PATH se actualice.'));
  }

  // 3. ¿Está levantado y con qué modelos?
  console.log('\n3) ¿Está levantado el servicio?');
  const listing = await listModels();
  const installed = listing.ok ? listing.models.map((m) => String(m.name || '')) : [];

  if (!listing.ok) {
    console.log(`   ${red('No responde')} en ${BASE} · ${listing.reason}`);
    console.log(
      dim('   Si acabas de instalarlo, abre la app de Ollama (o ejecuta `ollama serve`).')
    );
  } else if (installed.length === 0) {
    console.log(`   ${yellow('Responde, pero sin ningún modelo descargado.')}`);
    console.log(`   Descarga el que te toca:   ollama pull ${pick.model}`);
  } else {
    console.log(`   ${green('Sí')} · ${installed.length} modelo(s): ${installed.slice(0, 6).join(', ')}`);
  }

  // 4. La prueba de verdad: un turno cronometrado.
  const modelToTest = forcedModel || (installed.find((name) => name.startsWith(pick.model.split(':')[0])) ?? installed[0] ?? '');
  let measured = null;

  if (listing.ok && modelToTest) {
    console.log(`\n4) Prueba real con «${modelToTest}» (puede tardar: el modelo se carga en memoria)`);
    measured = await measure(modelToTest);
    if (measured.ok) {
      console.log(`   ${green('Contesta')} · ${measured.ms} ms · ${measured.words} palabras (~${measured.perSecond} palabras/s)`);
      console.log(dim(`   «${measured.text.replace(/\s+/g, ' ').slice(0, 160)}…»`));
      if (measured.ms > 45_000) {
        console.log(
          `   ${yellow('Es lento.')} El chat del catedrático tiene tope de 30 s por turno, así que este modelo valdría como respaldo de fondo (apuntes, mantenimiento) más que para preguntas del día a día.`
        );
      }
    } else {
      console.log(`   ${red('No ha contestado')} (${measured.ms} ms) · ${measured.reason}`);
      if (/\b404\b/.test(String(measured.reason))) {
        console.log(`   Ese modelo no está descargado:  ollama pull ${modelToTest}`);
      }
    }
  } else if (listing.ok) {
    console.log('\n4) Prueba real: (no hay ningún modelo que probar todavía)');
  }

  // 5. Cómo queda la app.
  const env = readEnv();
  const enabled = (env.OLLAMA_ENABLED || '').toLowerCase();

  console.log('\n5) Qué le falta a la app');
  if (enabled === 'false') {
    console.log(`   ${yellow('OLLAMA_ENABLED=false')} en tu .env: el motor local está apagado a propósito.`);
    console.log('   Ponlo en «true» (o quita la línea) si lo quieres como respaldo.');
  } else if (listing.ok && installed.length > 0) {
    console.log(
      `   ${green('Nada:')} en cuanto Ollama responde, la app lo detecta sola y lo usa como último recurso.`
    );
    console.log('   Los catedráticos siguen intentando Gemini y Groq primero (escriben mejor) y caen aquí solo cuando su cupo se agota.');
  } else {
    console.log('   Sin servidor local, la app funciona con Gemini y Groq.');
    console.log('   Cuando su cupo se agota, es cuando entra el modelo local: por eso merece la pena tenerlo aunque sea pequeño.');
  }

  // 6. Acciones (opcional).
  const needsPull = listing.ok && !installed.some((name) => name.startsWith(pick.model.split(':')[0]));
  if (shouldPull && needsPull) {
    console.log(`\n6) Descargando ${pick.model} (esto baja ${pick.download})…`);
    try {
      execFileSync('ollama', ['pull', pick.model], { stdio: 'inherit' });
      console.log(`${green('Descargado.')} Vuelve a lanzar el chequeo para verlo medido.`);
    } catch (error) {
      console.log(`${red('No se ha podido descargar.')} ${error instanceof Error ? error.message : error}`);
    }
  } else if (needsPull) {
    console.log(`\n   Paso siguiente:  ollama pull ${pick.model}   ${dim('(o: npm run ollama:doctor -- --pull)')}`);
  }

  const ready = listing.ok && installed.length > 0 && (measured === null || measured.ok);
  console.log(
    ready
      ? `\n${green('Listo:')} este ordenador puede llevar los catedráticos cuando la nube se quede sin cupo.\n`
      : `\n${yellow('Todavía no:')} ahora mismo el respaldo local no está disponible. Lo de arriba es el paso exacto que falta.\n`
  );

  process.exitCode = ready ? 0 : 1;
}

main().catch((error) => {
  console.error('[ollama:doctor]', error);
  process.exit(1);
});
