/**
 * Verificación del motor de IA (src/lib/aiEngine.ts) sin gastar API ni claves
 * reales: compila el módulo, intercepta `fetch` y comprueba
 *   1) el comportamiento sin claves configuradas,
 *   2) la forma exacta de la petición a Groq (Bearer + /chat/completions),
 *   3) la rotación de modelos cuando uno devuelve 429,
 *   4) el resultado unificado y el ranking de /ajustes,
 *   5) el tope de tiempo del turno, con un proveedor colgado de mentira y el
 *      reloj de verdad (un turno no puede tener al alumno esperando),
 *   6) el reparto de carga entre varias claves del mismo proveedor y la
 *      prioridad del trabajo de fondo (cede el turno cuando el cupo está justo),
 * 7) el respaldo local (Ollama) cuando la nube entera está seca,
 * 8) OpenRouter como TERCERA vía de la nube: el orden pactado de la cadena, que
 *    solo entren sus modelos `:free`, y que una clave suya rechazada no tumbe al
 *    proveedor.
 *
 * Uso:
 *   node scripts/verify-ai-engine.js          → pruebas con fetch interceptado (gratis)
 *   node scripts/verify-ai-engine.js --live   → una llamada REAL a Groq con tu clave
 *                                               del .env, para comprobar el respaldo
 */
const path = require('path');
const { execFileSync } = require('child_process');
const fs = require('fs');

const projectRoot = path.join(__dirname, '..');
const outDir = path.join(projectRoot, '.tmp-verify-ai');

// El umbral de RAM para el modelo local se pone a 0 en TODA la suite: aquí se
// prueba el respaldo con un Ollama de mentira y el resultado no puede depender
// de cuánta memoria libre tenga el equipo que ejecuta las pruebas.
process.env.OLLAMA_MIN_FREE_MB = '0';

fs.rmSync(outDir, { recursive: true, force: true });

execFileSync(
  process.execPath,
  [
    require.resolve('typescript/bin/tsc'),
    path.join('src', 'lib', 'aiEngine.ts'),
    '--outDir',
    '.tmp-verify-ai',
    '--module',
    'commonjs',
    '--target',
    'es2022',
    '--moduleResolution',
    'node',
    '--skipLibCheck',
  ],
  { cwd: projectRoot, stdio: 'inherit' }
);

const engine = require(path.join(outDir, 'aiEngine.js'));

let calls = [];
let failures = 0;

function check(label, condition, extra) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FALLO ${label}`, extra === undefined ? '' : extra);
  }
}

function jsonResponse(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  };
}

const LIVE = process.argv.includes('--live');

/** Carga las claves del .env (sin imprimirlas) para el modo --live. */
function loadEnv() {
  const envPath = path.join(projectRoot, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    const value = match[2].replace(/^['"]|['"]$/g, '').trim();
    if (value && !process.env[match[1]]) process.env[match[1]] = value;
  }
}

/** Prueba en vivo: usa la clave real de Groq y una petición de ida y vuelta. */
async function liveTest() {
  loadEnv();
  process.env.AI_PROVIDER = 'groq';

  const key = (process.env.GROQ_API_KEY || '').trim();
  console.log('1) Clave de Groq en .env');
  check('presente y con formato gsk_', key.startsWith('gsk_') && key.length > 30, `longitud ${key.length}`);

  const reply = await engine.runAiText({
    systemInstruction: 'Responde en una sola frase, en español.',
    message: 'Dime el resultado de 2+2 y nada más.',
  });

  console.log('\n2) Respuesta real del motor por Groq');
  check('proveedor = groq', reply.provider === 'groq', reply.provider);
  check('modelo anunciado', typeof reply.model === 'string' && reply.model.length > 0, reply.model);
  check('texto no vacío', reply.text.trim().length > 0);
  console.log(`   modelo: ${reply.model}`);
  console.log(`   respuesta: ${reply.text.trim().slice(0, 160)}`);

  const status = await engine.getEngineStatus();
  console.log('\n3) Estado del motor');
  check('Groq configurado', status.providers.find((p) => p.id === 'groq').configured === true);
  console.log(`   próximo modelo elegido: ${status.nextKey}`);
  console.log(`   llamadas contabilizadas: ${JSON.stringify(status.usage)}`);
  for (const model of status.ranked) {
    console.log(
      `   ${model.coolingSeconds > 0 ? `[enfriando ${model.coolingSeconds}s]` : '[disponible]'} ${model.key}`
    );
  }

  console.log(failures === 0 ? '\nTODO EN VERDE' : `\n${failures} COMPROBACIONES FALLIDAS`);
  fs.rmSync(outDir, { recursive: true, force: true });
  process.exitCode = failures === 0 ? 0 : 1;
}

async function main() {
  if (LIVE) return liveTest();

  console.log('1) Sin claves configuradas');
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.GROQ_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY_2;
  delete process.env.OPENROUTER_API_KEY_3;
  check('hasAiProvider() es false', engine.hasAiProvider() === false);
  check('etiqueta "sin configurar"', engine.getConfiguredModelLabel() === 'sin configurar');
  let error = null;
  try {
    await engine.runAiText({ systemInstruction: 'x', message: 'hola' });
  } catch (caught) {
    error = caught;
  }
  check('lanza error 503 con mensaje claro', error && error.status === 503, error && error.message);

  console.log('\n2) Solo Groq configurado (clave falsa, fetch interceptado)');
  process.env.GROQ_API_KEY = 'fake-groq-key';
  process.env.AI_PROVIDER = 'groq';

  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    const body = JSON.parse(options.body || '{}');

    if (String(url).includes('/models')) {
      return jsonResponse({
        data: [
          { id: 'openai/gpt-oss-120b' },
          { id: 'openai/gpt-oss-20b' },
          { id: 'llama-3.3-70b-versatile' },
          { id: 'llama-3.1-8b-instant' },
          { id: 'whisper-large-v3' },
          { id: 'canopylabs/orpheus-v1-english' },
          { id: 'qwen/qwen3.8-27b-preview' },
        ],
      });
    }

    // El modelo grande devuelve 429 para probar la rotación interna de Groq.
    if (body.model === 'openai/gpt-oss-120b') {
      return jsonResponse(
        { error: { message: 'Rate limit reached for requests per day (RPD)' } },
        429,
        { 'retry-after': '20' }
      );
    }

    return jsonResponse({
      choices: [{ message: { role: 'assistant', content: '[[etapa:pista_1]] Respuesta de prueba.' } }],
    });
  };

  const result = await engine.runAiText({
    systemInstruction: 'Eres un catedrático.',
    messages: [
      { role: 'user', content: '¿Qué es una derivada?' },
      { role: 'assistant', content: 'Es una tasa de cambio instantánea.' },
    ],
    message: 'Ponme un ejemplo.',
  });

  const chatCalls = calls.filter((c) => c.url.includes('/chat/completions'));
  // La última llamada es la del modelo que sí respondió (tras el 429 del primero).
  const chatCall = chatCalls[chatCalls.length - 1];
  const chatBody = chatCall ? JSON.parse(chatCall.options.body) : {};
  const authHeader = chatCall ? chatCall.options.headers.Authorization : '';

  console.log('\n3) Forma exacta de la petición a Groq');
  check('endpoint correcto', Boolean(chatCall) && chatCall.url === 'https://api.groq.com/openai/v1/chat/completions', chatCall && chatCall.url);
  check('cabecera Authorization: Bearer', authHeader === 'Bearer fake-groq-key', authHeader);
  check('Content-Type JSON', chatCall && chatCall.options.headers['Content-Type'] === 'application/json');
  check(
    'se reintentó con el siguiente modelo tras el 429',
    chatCalls.length === 2 && chatCalls[0] && JSON.parse(chatCalls[0].options.body).model === 'openai/gpt-oss-120b' && chatBody.model === 'openai/gpt-oss-20b',
    `intentos: ${chatCalls.map((c) => JSON.parse(c.options.body).model).join(' -> ')}`
  );
  check(
    'historial convertido a mensajes de chat',
    chatBody.messages.length === 4 &&
      chatBody.messages[0].role === 'system' &&
      chatBody.messages[1].content === '¿Qué es una derivada?' &&
      chatBody.messages[3].role === 'user' &&
      chatBody.messages[3].content === 'Ponme un ejemplo.',
    JSON.stringify(chatBody.messages)
  );

  console.log('\n4) Resultado unificado');
  check('proveedor = groq', result.provider === 'groq', result.provider);
  check('modelo = openai/gpt-oss-20b', result.model === 'openai/gpt-oss-20b', result.model);
  check('texto devuelto íntegro', result.text === '[[etapa:pista_1]] Respuesta de prueba.', result.text);
  check('sin pasos crudos (no aplica a Groq)', Array.isArray(result.steps) && result.steps.length === 0);

  const status = await engine.getEngineStatus();
  console.log('\n5) Estado del motor');
  check('Groq marcado como conectado', status.providers.find((p) => p.id === 'groq').configured === true);
  check('Gemini marcado como no configurado', status.providers.find((p) => p.id === 'gemini').configured === false);
  check(
    'ranking ignora audio, TTS y previews',
    status.ranked.every((m) => !/whisper|preview|orpheus/i.test(m.model)),
    status.ranked.map((m) => m.key).join(', ')
  );
  check('modelo en enfriamiento anotado con 429', /quota/.test(JSON.stringify(status.ranked)), JSON.stringify(status.ranked.slice(0, 2)));
  check('uso contabilizado', status.usage.calls >= 1 && status.usage.byProvider.groq === 1, JSON.stringify(status.usage));

  /* ---------------------------------------------------------------- */
  /* 6) Adjuntos: la captura y el PDF tal y como salen hacia la API    */
  /* ---------------------------------------------------------------- */
  console.log('\n6) Gemini multimodal: el turno con adjuntos (captura + PDF)');
  delete process.env.GROQ_API_KEY;
  process.env.GEMINI_API_KEY = 'fake-gemini-key';
  process.env.AI_PROVIDER = 'gemini';
  calls = [];

  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });

    if (String(url).includes('/models')) {
      return jsonResponse({
        models: [
          { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
        ],
      });
    }

    return jsonResponse({
      steps: [
        {
          type: 'model_output',
          content: [{ type: 'text', text: '[[etapa:diagnostico]] Veo tu captura.' }],
        },
      ],
    });
  };

  const pdfPart = { name: 'Tema 3.pdf', mimeType: 'application/pdf', data: 'JVBERi0xLjQK' };
  const imagePart = { name: 'captura.png', mimeType: 'image/png', data: 'iVBORw0KGgo=' };

  const multi = await engine.runAiText({
    systemInstruction: 'Eres un catedrático.',
    message: 'Mira estos dos archivos.',
    attachments: [pdfPart, imagePart],
  });

  const interactionCalls = calls.filter((c) => c.url.includes('/interactions'));
  const multiBody =
    interactionCalls.length > 0 ? JSON.parse(interactionCalls[interactionCalls.length - 1].options.body) : {};
  const multiStep = Array.isArray(multiBody.input) ? multiBody.input[multiBody.input.length - 1] : null;
  const multiContent = multiStep && Array.isArray(multiStep.content) ? multiStep.content : [];

  check(
    'petición al endpoint de Interactions del mejor modelo Gemini',
    interactionCalls.length > 0 && multiBody.model === 'gemini-3.8-flash',
    multiBody.model
  );
  check('system_instruction viaja en la petición', typeof multiBody.system_instruction === 'string' && multiBody.system_instruction.length > 0);
  check('la conversación no se guarda en el proveedor (store: false)', multiBody.store === false);
  check('el turno va como user_input', multiStep && multiStep.type === 'user_input');
  check(
    'el contenido pasa a ser una lista: el texto + un archivo por adjunto',
    multiContent.length === 3,
    JSON.stringify(multiContent)
  );
  check(
    'el texto va primero e íntegro',
    multiContent[0] && multiContent[0].type === 'text' && multiContent[0].text === 'Mira estos dos archivos.'
  );
  check(
    'el PDF viaja como `document` con su mime_type y su base64',
    multiContent[1] &&
      multiContent[1].type === 'document' &&
      multiContent[1].mime_type === 'application/pdf' &&
      multiContent[1].data === 'JVBERi0xLjQK',
    JSON.stringify(multiContent[1])
  );
  check(
    'la captura viaja como `image`',
    multiContent[2] && multiContent[2].type === 'image' && multiContent[2].mime_type === 'image/png'
  );
  // La API real rechaza cualquier campo que no sean type/mime_type/data.
  check(
    'ninguna parte lleva campos que la API rechace',
    multiContent.every((part) => {
      const keys = Object.keys(part).sort().join(',');
      return part.type === 'text' ? keys === 'text,type' : keys === 'data,mime_type,type';
    }),
    JSON.stringify(multiContent.map((part) => Object.keys(part)))
  );
  check(
    'PDF → document y lo visual → image',
    engine.attachmentMediaKind('application/pdf') === 'document' &&
      engine.attachmentMediaKind('image/png') === 'image' &&
      engine.attachmentMediaKind('image/jpeg') === 'image',
    engine.attachmentMediaKind('application/pdf')
  );
  check(
    'el motor devuelve el texto del modelo tal cual (la etiqueta de etapa la quita la capa del tutor)',
    multi.text === '[[etapa:diagnostico]] Veo tu captura.',
    multi.text
  );
  check('y los pasos crudos vienen para poder reenviar el turno', Array.isArray(multi.steps) && multi.steps.length === 1);

  /* ---------------------------------------------------------------- */
  /* 7) Sin adjuntos, texto plano (y aviso honesto para quien no lee)  */
  /* ---------------------------------------------------------------- */
  console.log('\n7) Sin adjuntos es texto plano y Groq avisa de que no lee archivos');
  calls = [];
  await engine.runAiText({ systemInstruction: 'x', message: 'Solo texto.' });
  const plainBody = JSON.parse(calls.filter((c) => c.url.includes('/interactions')).pop().options.body);
  const plainStep = plainBody.input[plainBody.input.length - 1];

  check(
    'sin adjuntos el contenido sigue siendo una cadena',
    typeof plainStep.content === 'string' && plainStep.content === 'Solo texto.',
    JSON.stringify(plainStep.content)
  );
  check(
    'buildUserInputStep sin adjuntos devuelve una cadena',
    typeof engine.buildUserInputStep('hola').content === 'string'
  );
  check(
    'buildUserInputStep con adjunto devuelve texto + documento',
    (() => {
      const step = engine.buildUserInputStep('hola', [pdfPart]);
      return (
        Array.isArray(step.content) &&
        step.content.length === 2 &&
        step.content[1].type === 'document'
      );
    })()
  );

  const noReadNote = engine.attachmentsNotReadableNote([pdfPart]);
  check(
    'el aviso al proveedor sin visión nombra el archivo',
    noReadNote.includes('Tema 3.pdf'),
    noReadNote.slice(0, 90)
  );
  check(
    'y además le prohíbe suponer su contenido',
    /no los has visto/i.test(noReadNote)
  );
  check('sin adjuntos no hay aviso', engine.attachmentsNotReadableNote([]) === '');

  /* ---------------------------------------------------------------- */
  /* 8) El tope de tiempo del turno (que no se quede colgado)          */
  /* ---------------------------------------------------------------- */
  console.log('\n8) El tope de tiempo: un proveedor colgado no puede tener al alumno esperando');
  check(
    'el presupuesto de un turno de chat son 30 s',
    engine.AI_TEXT_BUDGET_MS === 30000,
    `${engine.AI_TEXT_BUDGET_MS} ms`
  );
  check(
    'cada intento tiene su propio tope',
    engine.AI_ATTEMPT_MAX_MS === 16000,
    `${engine.AI_ATTEMPT_MAX_MS} ms`
  );
  check(
    'y un intento nunca puede durar más que el turno entero',
    engine.AI_ATTEMPT_MAX_MS <= engine.AI_TEXT_BUDGET_MS
  );

  // Un proveedor que solo termina cuando le cortan: es exactamente lo que pasa
  // cuando la API se queda colgada. Aquí se mide el reloj de verdad.
  process.env.GROQ_API_KEY = 'fake-groq-key';
  process.env.AI_PROVIDER = 'groq';
  calls = [];

  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });

    if (String(url).includes('/models')) {
      return jsonResponse({
        data: [{ id: 'openai/gpt-oss-120b' }, { id: 'openai/gpt-oss-20b' }],
      });
    }

    // Ojo: el temporizador del `AbortSignal.timeout` va suelto (unref), así que
    // sin este otro temporizador Node daría por terminado el script. Aquí es lo
    // que mantiene vivo el proceso hasta que el motor corta la petición.
    return new Promise((_resolve, reject) => {
      const mantener = setTimeout(() => {}, 60_000);
      options.signal.addEventListener('abort', () => {
        clearTimeout(mantener);
        const error = new Error('The operation was aborted due to timeout');
        error.name = 'TimeoutError';
        reject(error);
      });
    });
  };

  const BUDGET = 6000;
  const startedAt = Date.now();
  let topeError = null;
  try {
    await engine.runAiText({
      systemInstruction: 'x',
      message: 'y',
      budgetMs: BUDGET,
      attemptMs: 4000,
    });
  } catch (caught) {
    topeError = caught;
  }
  const elapsed = Date.now() - startedAt;
  const modelCalls = calls.filter((call) => call.url.includes('/chat/completions')).length;

  check('un proveedor colgado acaba en error, no se queda esperando', topeError !== null, topeError ? topeError.message : 'no lanzó');
  check(
    `no se pasa del presupuesto (${BUDGET} ms)`,
    elapsed <= BUDGET + 900,
    `tardó ${elapsed} ms`
  );
  check(
    'y lo cuenta como problema de tiempo (503), no como «no hay claves»',
    topeError !== null && topeError.status === 503,
    topeError ? `${topeError.status} · ${topeError.message.slice(0, 90)}` : '—'
  );
  const trace = engine.getLastDecision();
  check(
    'el rastro deja apuntado que no hubo tiempo para más',
    JSON.stringify(trace && trace.attempts).includes('budget'),
    trace ? trace.attempts.map((attempt) => `${attempt.key}:${attempt.outcome}`).join(' | ') : '—'
  );
  console.log(`   medido: ${modelCalls} intento(s) contra el proveedor y ${elapsed} ms en total (tope ${BUDGET} ms)`);

  // Presupuesto diminuto: no se molesta a nadie y contesta en el acto.
  calls = [];
  const startedMin = Date.now();
  let minimoError = null;
  try {
    await engine.runAiText({ systemInstruction: 'x', message: 'y', budgetMs: 1 });
  } catch (caught) {
    minimoError = caught;
  }
  const elapsedMin = Date.now() - startedMin;
  check('sin presupuesto no se llama siquiera al proveedor', calls.length === 0, `${calls.length} petición(es)`);
  check('y contesta en el acto', elapsedMin < 1500, `${elapsedMin} ms`);
  check(
    'con el mismo aviso de tiempo',
    minimoError !== null && minimoError.status === 503,
    minimoError ? `${minimoError.status}` : '—'
  );
  console.log(`   medido: ${elapsedMin} ms para rechazar un turno sin presupuesto (0 llamadas)`);

  /* ---------------------------------------------------------------- */
  /* 9) Un proveedor caído no se come el turno entero                   */
  /* ---------------------------------------------------------------- */
  /*
   * El caso real: Gemini con el cupo gratuito agotado y sus modelos
   * contestando 502 de «high demand» (cada uno tarda segundos), y una clave de
   * Groq sana sin usar. Antes, los reintentos del primer modelo se comían los
   * 30 s del turno: el alumno recibía un 503 sin que se hubiera probado ni un
   * modelo de Groq. Se mide en un proceso aparte para partir de estado limpio
   * (sin enfriamientos ni catálogos en caché de las pruebas anteriores).
   */
  console.log('\n9) Un proveedor saturado no se come el turno entero (Gemini caído, Groq sano)');

  const childCode = `
const engine = require(${JSON.stringify(path.join(outDir, 'aiEngine.js'))});
process.env.GEMINI_API_KEY = 'fake-gemini-key';
process.env.GROQ_API_KEY = 'fake-groq-key';
process.env.AI_PROVIDER = 'auto';

let geminiAttempts = 0;
global.fetch = async (url, options) => {
  const target = String(url);
  if (target.includes('groq.com') && target.includes('/models')) {
    return json({
      data: [{ id: 'openai/gpt-oss-120b' }, { id: 'openai/gpt-oss-20b' }],
    });
  }
  if (target.includes('/models')) {
    return json({
      models: [
        { name: 'models/gemini-4.1-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-4.0-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.9-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.7-flash', supportedGenerationMethods: ['generateContent'] },
      ],
    });
  }
  if (target.includes('groq.com')) {
    return json({ choices: [{ message: { role: 'assistant', content: 'Respuesta de Groq.' } }] });
  }
  // Gemini: el 502 real de «high demand» no es instantáneo, tarda segundos.
  geminiAttempts += 1;
  await new Promise((resolve) => setTimeout(resolve, 5000));
  return json({ error: { message: 'This model is currently experiencing high demand.' } }, 502);
};

function json(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  };
}

(async () => {
  const startedAt = Date.now();
  let result = null;
  let error = null;
  try {
    result = await engine.runAiText({ systemInstruction: 'Eres un catedrático.', message: 'Pista.' });
  } catch (caught) {
    error = caught;
  }
  const elapsed = Date.now() - startedAt;
  const attempts = engine.getLastDecision() ? engine.getLastDecision().attempts : [];
  console.log(
    'RESULTADO ' +
      JSON.stringify({
        provider: result && result.provider,
        text: result && result.text,
        errorStatus: error ? error.status : null,
        elapsed,
        geminiAttempts,
        attempts: attempts.map((a) => a.key + ':' + a.outcome),
      })
  );
})();
`;

  let child = '';
  try {
    child = execFileSync(process.execPath, ['-e', childCode], { cwd: projectRoot, encoding: 'utf8' });
  } catch (caught) {
    child = `${caught.stdout || ''}${caught.stderr || ''}`;
  }

  const line = (child || '').split('\n').find((l) => l.startsWith('RESULTADO '));
  let report = null;
  try {
    report = line ? JSON.parse(line.slice('RESULTADO '.length)) : null;
  } catch {
    report = null;
  }

  check('la prueba se ejecuta y deja su medida', report !== null, (child || '').slice(0, 300));
  check(
    'el turno se contesta por el otro proveedor, no se queda en 503',
    Boolean(report) && report.provider === 'groq' && report.errorStatus === null,
    report ? `proveedor ${report.provider} · error ${report.errorStatus}` : '—'
  );
  check(
    'y con la respuesta buena',
    Boolean(report) && report.text === 'Respuesta de Groq.',
    report ? report.text : '—'
  );
  check(
    'no se espera al proveedor caído más de la cuenta',
    Boolean(report) && report.elapsed < 12_000,
    report ? `${report.elapsed} ms` : '—'
  );
  check(
    'no se reintenta el modelo caído hasta agotar el turno',
    Boolean(report) && report.geminiAttempts <= 2,
    report ? `${report.geminiAttempts} intento(s) contra Gemini` : '—'
  );
  if (report) {
    console.log(
      `   medido: contestado por ${report.provider} en ${report.elapsed} ms, con ${report.geminiAttempts} intento(s) contra Gemini`
    );
    console.log(`   rastro: ${report.attempts.join(' | ')}`);
  }

  /* ---------------------------------------------------------------- */
  /* 10) El cupo es de la CLAVE: varias claves reparten la carga        */
  /* ---------------------------------------------------------------- */
  /*
   * El límite gratuito de Google y de Groq se cuenta por clave. Con una sola,
   * un día intenso la agota y todo el chat se queda en modo local aunque al
   * proveedor le sobre capacidad. Aquí se comprueba que una clave sin cupo (o
   * una clave inválida) no arrastra a las demás: el turno pasa a la siguiente
   * en el mismo momento, sin que el alumno note nada.
   *
   * Va en un proceso aparte para partir de un estado limpio (sin enfriamientos
   * de las pruebas de arriba).
   */
  console.log('\n10) El cupo es de la clave: una clave agotada no tumba al proveedor');

  const keysChildCode = `
const engine = require(${JSON.stringify(path.join(outDir, 'aiEngine.js'))});
// El hijo hereda el entorno del padre (que ya ha usado una clave falsa de Groq).
delete process.env.GROQ_API_KEY;
delete process.env.GROQ_API_KEY_2;
process.env.GEMINI_API_KEY = 'clave-uno';
process.env.GEMINI_API_KEY_2 = 'clave-dos';
process.env.GEMINI_API_KEY_3 = 'clave-tres';
process.env.AI_PROVIDER = 'gemini';

const pedidas = [];
const modo = { dos: 200 };

function json(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  };
}

global.fetch = async (url, options) => {
  if (String(url).includes('/models')) {
    return json({ models: [{ name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] }] });
  }
  const clave = options.headers['x-goog-api-key'];
  pedidas.push(clave);
  if (clave === 'clave-uno') {
    return json({ error: { message: 'You exceeded your current quota, per day' } }, 429);
  }
  if (clave === 'clave-dos' && modo.dos !== 200) {
    return json({ error: { message: 'API key not valid. Please pass a valid API key.' } }, modo.dos);
  }
  return json({
    steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Respuesta con ' + clave + '.' }] }],
  });
};

(async () => {
  const out = {};
  out.claves = engine.getProviderKeys('gemini').map((k) => k.label + ':' + k.envVar);

  // Turno 1: la clave principal está sin cupo → tiene que contestar la 2.
  const primero = await engine.runAiText({ systemInstruction: 'x', message: 'turno uno' });
  out.textoPrimero = primero.text;
  out.clavesPrimero = pedidas.slice();
  out.rastroPrimero = (engine.getLastDecision() ? engine.getLastDecision().attempts : []).map((a) => a.key + ':' + a.outcome);

  const estado = await engine.getEngineStatus();
  const gemini = estado.providers.find((p) => p.id === 'gemini');
  out.estadoClaves = gemini.keys.map((k) => k.label + ':' + (k.coolingSeconds > 0 ? 'enfriada' : 'disponible') + ':' + k.lastStatus);
  out.disponibles = gemini.keysAvailable;
  // El cupo es de cada MODELO con cada clave: el modelo se queda sin cupo con la
  // clave principal y sigue teniéndolo con la 2 (y la clave principal sigue
  // sirviendo para los demás modelos).
  out.cupoParPrincipal = engine.getPairCooldownSeconds('gemini:gemini-3.8-flash', 'principal');
  out.cupoParDos = engine.getPairCooldownSeconds('gemini:gemini-3.8-flash', '2');
  out.modelosSinCupoPrincipal = gemini.keys.find((k) => k.label === 'principal').modelsOutOfQuota;
  out.clavesExtra = gemini.extraKeyEnv;
  out.tieneValorDeClave = JSON.stringify(estado).includes('clave-uno') || JSON.stringify(estado).includes('clave-dos');

  // Turno 2: la 1 sigue enfriada → la 2 se usa a la primera (sin gastar tiempo).
  pedidas.length = 0;
  const segundo = await engine.runAiText({ systemInstruction: 'x', message: 'turno dos' });
  out.textoSegundo = segundo.text;
  out.clavesSegundo = pedidas.slice();

  // Turno 3: la 2 resulta ser inválida → tiene que contestar la 3.
  modo.dos = 401;
  pedidas.length = 0;
  const tercero = await engine.runAiText({ systemInstruction: 'x', message: 'turno tres' });
  out.textoTercero = tercero.text;
  out.clavesTercero = pedidas.slice();
  out.rastroTercero = (engine.getLastDecision() ? engine.getLastDecision().attempts : []).map((a) => a.key + ':' + a.outcome);

  // Turno 4: sin claves extra y con la única clave sin cupo, el aviso tiene que
  // decir cómo ampliarlo (es el momento exacto en el que el alumno lo necesita).
  delete process.env.GEMINI_API_KEY_2;
  delete process.env.GEMINI_API_KEY_3;
  out.clavesTurnoCuatro = engine.getProviderKeys('gemini').map((k) => k.envVar);
  let errorFinal = null;
  try {
    await engine.runAiText({ systemInstruction: 'x', message: 'turno cuatro' });
  } catch (caught) {
    errorFinal = caught;
  }
  out.errorStatus = errorFinal ? errorFinal.status : null;
  out.errorMensaje = errorFinal ? errorFinal.message : '';

  console.log('RESULTADO ' + JSON.stringify(out));
})();
`;

  let keysChild = '';
  try {
    keysChild = execFileSync(process.execPath, ['-e', keysChildCode], {
      cwd: projectRoot,
      encoding: 'utf8',
    });
  } catch (caught) {
    keysChild = `${caught.stdout || ''}${caught.stderr || ''}`;
  }

  const keysLine = (keysChild || '').split('\n').find((l) => l.startsWith('RESULTADO '));
  let pool = null;
  try {
    pool = keysLine ? JSON.parse(keysLine.slice('RESULTADO '.length)) : null;
  } catch {
    pool = null;
  }

  check('la prueba de claves se ejecuta y deja su medida', pool !== null, (keysChild || '').slice(0, 300));
  check(
    'las tres claves se leen del .env con su etiqueta',
    Boolean(pool) && pool.claves.join(',') === 'principal:GEMINI_API_KEY,2:GEMINI_API_KEY_2,3:GEMINI_API_KEY_3',
    pool ? pool.claves.join(',') : '—'
  );
  check(
    'con la principal sin cupo, contesta la clave 2',
    Boolean(pool) && pool.textoPrimero === 'Respuesta con clave-dos.',
    pool ? pool.textoPrimero : '—'
  );
  check(
    'y el intento fallido queda apuntado como cupo de esa clave',
    Boolean(pool) && pool.rastroPrimero.some((a) => /#principal:quota_daily/.test(a)),
    pool ? pool.rastroPrimero.join(' | ') : '—'
  );
  check(
    'el cupo se agota por modelo y clave, no por clave: la clave principal sigue disponible',
    Boolean(pool) &&
      pool.cupoParPrincipal > 0 &&
      pool.cupoParDos === 0 &&
      pool.disponibles === 3 &&
      pool.modelosSinCupoPrincipal === 1,
    pool
      ? `par modelo#principal: ${pool.cupoParPrincipal} s · par modelo#2: ${pool.cupoParDos} s · claves disponibles: ${pool.disponibles} · modelos sin cupo en la principal: ${pool.modelosSinCupoPrincipal}`
      : '—'
  );
  check(
    'el siguiente turno va directo a la clave buena (sin gastar el turno probando la mala)',
    Boolean(pool) && pool.clavesSegundo.join(',') === 'clave-dos' && pool.textoSegundo === 'Respuesta con clave-dos.',
    pool ? pool.clavesSegundo.join(',') : '—'
  );
  check(
    'una clave inválida tampoco tumba al proveedor: contesta la 3',
    Boolean(pool) && pool.textoTercero === 'Respuesta con clave-tres.' && pool.clavesTercero.join(',') === 'clave-dos,clave-tres',
    pool ? `${pool.clavesTercero.join(',')} → ${pool.textoTercero}` : '—'
  );
  check(
    'y el rastro distingue la clave mala de la que respondió',
    Boolean(pool) && pool.rastroTercero.some((a) => /#2:auth/.test(a)) && pool.rastroTercero.some((a) => /#3:ok/.test(a)),
    pool ? pool.rastroTercero.join(' | ') : '—'
  );
  check(
    'el estado del motor no expone el valor de ninguna clave',
    Boolean(pool) && pool.tieneValorDeClave === false
  );
  check(
    'con una sola clave sin cupo, el aviso dice cómo ampliarlo gratis',
    Boolean(pool) && pool.errorStatus === 429 && /GEMINI_API_KEY_2/.test(pool.errorMensaje),
    pool ? `${pool.errorStatus} · claves en el turno 4: ${pool.clavesTurnoCuatro.join(',')} · ${String(pool.errorMensaje).slice(0, 400)}` : '—'
  );
  if (pool) {
    console.log(`   medido: claves usadas por turno → ${pool.clavesPrimero.join(' → ')} | ${pool.clavesSegundo.join(' → ')} | ${pool.clavesTercero.join(' → ')}`);
  }

  /* ---------------------------------------------------------------- */
  /* 11) El reparto entre claves y el fondo que cede el turno al alumno  */
  /* ---------------------------------------------------------------- */
  /*
   * Dos cosas que evitan la saturación sin gastar un céntimo más:
   *
   *  a) REPARTO: si siempre se probara la misma clave primero, esa se comería
   *     todo el cupo y las demás mirarían. Con tres claves sanas, cuatro turnos
   *     seguidos tienen que salir por tres claves distintas y volver a la primera.
   *  b) PRIORIDAD: las tareas de mantenimiento (rondas, memoria, auditorías) no
   *     pueden quitarle el cupo a la respuesta que alguien está esperando. Con el
   *     cupo justo, un turno `priority: 'fondo'` se aparta SIN llamar siquiera al
   *     proveedor; un turno normal sigue funcionando igual.
   *
   * Proceso aparte para partir de estado limpio.
   */
  console.log('\n11) Reparto entre claves y el trabajo de fondo que cede el turno');

  const repartoChildCode = `
const engine = require(${JSON.stringify(path.join(outDir, 'aiEngine.js'))});
delete process.env.GROQ_API_KEY;
delete process.env.GROQ_API_KEY_2;
process.env.GEMINI_API_KEY = 'clave-uno';
process.env.GEMINI_API_KEY_2 = 'clave-dos';
process.env.GEMINI_API_KEY_3 = 'clave-tres';
process.env.AI_PROVIDER = 'gemini';

function json(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  };
}

let pedidas = [];
let llamadasAlProveedor = 0;
const modo = { agotar: null };

global.fetch = async (url, options) => {
  if (String(url).includes('/models')) {
    return json({ models: [{ name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] }] });
  }
  // La sonda del motor local se contesta aquí (y sin modelos) para que este
  // escenario sea el que dice ser: Gemini y nada más. Si esta llamada contara
  // como intento al proveedor, «un turno = una llamada» mediría la sonda, no un
  // reintento de verdad.
  if (String(url).includes('/api/tags')) {
    return json({ models: [] });
  }
  llamadasAlProveedor += 1;
  const clave = options.headers['x-goog-api-key'];
  pedidas.push(clave);
  if (clave === modo.agotar) {
    // Un 429 por minuto (no diario): enfria 3 minutos, que es el caso real.
    return json({ error: { message: 'Rate limit reached for requests per minute.' } }, 429);
  }
  return json({
    steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Respuesta con ' + clave + '.' }] }],
  });
};

(async () => {
  const out = {};

  // a) Tres claves sanas: el turno empieza por la que menos se ha usado.
  out.cupoJustoAlEmpezar = engine.isQuotaTight();
  const reparto = [];
  for (let turno = 0; turno < 4; turno++) {
    pedidas = [];
    await engine.runAiText({ systemInstruction: 'x', message: 'turno ' + turno });
    reparto.push(pedidas[0]);
  }
  out.reparto = reparto;
  out.turnosConUnaSolaLlamada = llamadasAlProveedor === 4;

  const estado = await engine.getEngineStatus();
  const gemini = estado.providers.find((p) => p.id === 'gemini');
  out.usoPorClave = gemini.keys.map((k) => k.label + ':' + k.used);
  out.estadoCupoJusto = estado.quotaTight;

  // b) Con el cupo sano, un turno de fondo se ejecuta con normalidad.
  pedidas = [];
  const fondoSano = await engine.runAiText({
    systemInstruction: 'x',
    message: 'ronda de mantenimiento',
    priority: 'fondo',
  });
  out.fondoConCupoSano = fondoSano.text;
  // Sigue el reparto: después de cuatro turnos (uno:2, dos:1, tres:1) le toca a
  // la clave que menos se ha usado, que es la 2.
  out.fondoClave = pedidas[0];

  // c) Cupo justo: queda una sola clave y se agota.
  delete process.env.GEMINI_API_KEY_2;
  delete process.env.GEMINI_API_KEY_3;
  modo.agotar = 'clave-uno';
  let errorAgotando = null;
  try {
    await engine.runAiText({ systemInstruction: 'x', message: 'agotar la ultima clave' });
  } catch (caught) {
    errorAgotando = caught;
  }
  out.errorAgotando = errorAgotando ? errorAgotando.status : null;
  out.cupoJustoTrasAgotar = engine.isQuotaTight();
  out.estadoCupoJustoTrasAgotar = (await engine.getEngineStatus()).quotaTight;

  const llamadasAntesDelFondo = llamadasAlProveedor;
  let errorFondo = null;
  try {
    await engine.runAiText({
      systemInstruction: 'x',
      message: 'ronda de mantenimiento con el cupo justo',
      priority: 'fondo',
    });
  } catch (caught) {
    errorFondo = caught;
  }
  out.fondoStatus = errorFondo ? errorFondo.status : null;
  out.fondoMensaje = errorFondo ? errorFondo.message : '';
  out.mensajeDelMotor = engine.BACKGROUND_YIELD_MESSAGE;
  out.llamadasDelFondo = llamadasAlProveedor - llamadasAntesDelFondo;

  console.log('RESULTADO ' + JSON.stringify(out));
})();
`;

  let repartoChild = '';
  try {
    repartoChild = execFileSync(process.execPath, ['-e', repartoChildCode], {
      cwd: projectRoot,
      encoding: 'utf8',
    });
  } catch (caught) {
    repartoChild = `${caught.stdout || ''}${caught.stderr || ''}`;
  }

  const repartoLine = (repartoChild || '').split('\n').find((l) => l.startsWith('RESULTADO '));
  let reparto = null;
  try {
    reparto = repartoLine ? JSON.parse(repartoLine.slice('RESULTADO '.length)) : null;
  } catch {
    reparto = null;
  }

  check('la prueba de reparto se ejecuta y deja su medida', reparto !== null, (repartoChild || '').slice(0, 300));
  check(
    'con el cupo intacto el reparto empieza por la clave menos usada y rota entre todas',
    Boolean(reparto) &&
      reparto.reparto.join(',') === 'clave-uno,clave-dos,clave-tres,clave-uno',
    reparto ? reparto.reparto.join(' → ') : '—'
  );
  check(
    'y cada turno sale a la primera (una sola llamada al proveedor)',
    Boolean(reparto) && reparto.turnosConUnaSolaLlamada === true
  );
  check(
    'la tarjeta de Ajustes puede enseñar el uso real de cada clave',
    Boolean(reparto) && reparto.usoPorClave.join(',') === 'principal:2,2:1,3:1',
    reparto ? reparto.usoPorClave.join(',') : '—'
  );
  check(
    'con el cupo sano, un turno de FONDO se ejecuta con normalidad',
    Boolean(reparto) &&
      reparto.cupoJustoAlEmpezar === false &&
      /^Respuesta con clave-(uno|dos|tres)\.$/.test(reparto.fondoConCupoSano || ''),
    reparto ? `cupoJusto=${reparto.cupoJustoAlEmpezar} · ${reparto.fondoConCupoSano}` : '—'
  );
  check(
    'y sin cupo caído el reparto sigue repartiendo (le toca a la menos usada)',
    Boolean(reparto) && reparto.fondoClave === 'clave-dos',
    reparto ? String(reparto.fondoClave) : '—'
  );
  check(
    'agotada la última clave, el motor lo dice y el estado lo enseña',
    Boolean(reparto) &&
      reparto.errorAgotando === 429 &&
      reparto.cupoJustoTrasAgotar === true &&
      reparto.estadoCupoJustoTrasAgotar === true,
    reparto ? `error ${reparto.errorAgotando} · cupoJusto ${reparto.cupoJustoTrasAgotar}` : '—'
  );
  check(
    'el turno de FONDO se aparta con un aviso propio (429), no como un fallo',
    Boolean(reparto) && reparto.fondoStatus === 429 && reparto.fondoMensaje === reparto.mensajeDelMotor,
    reparto ? `${reparto.fondoStatus} · ${String(reparto.fondoMensaje).slice(0, 120)}` : '—'
  );
  check(
    'y no llega a molestar al proveedor: cero llamadas',
    Boolean(reparto) && reparto.llamadasDelFondo === 0,
    reparto ? `${reparto.llamadasDelFondo} llamada(s)` : '—'
  );
  if (reparto) {
    console.log(
      `   medido: reparto entre claves → ${reparto.reparto.join(' → ')} · uso por clave: ${reparto.usoPorClave.join(', ')} · llamadas del turno de fondo con el cupo justo: ${reparto.llamadasDelFondo}`
    );
  }

  /*
   * 7) EL RESPALDO LOCAL (Ollama): los catedráticos 24/7.
   *
   * La pregunta que decide si la app aguanta un día de estudio intenso sin pagar
   * nada no es «¿funciona Gemini?» sino «¿qué pasa cuando su cupo se acaba?». Se
   * prueba con la nube seca (todos sus modelos devuelven 429) y un modelo local
   * de mentira levantado: el turno tiene que acabarlo el local, y el trabajo de
   * fondo tiene que seguir funcionando en vez de apartarse.
   */
  console.log('\n7) Respaldo local: qué pasa cuando el cupo de la nube se agota');

  const localChildCode = `
const path = require('path');
const engine = require(path.join(process.cwd(), '.tmp-verify-ai', 'aiEngine.js'));

let seen = [];
const respond = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  json: async () => body,
});

process.env.GEMINI_API_KEY = 'clave-de-nube';
delete process.env.GROQ_API_KEY;
// Un proceso hijo hereda el entorno del padre y el padre ha dejado
// AI_PROVIDER tocado en pruebas anteriores: aquí se pide «auto» de verdad.
delete process.env.AI_PROVIDER;
process.env.OLLAMA_ENABLED = 'auto';
process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
// La suite prueba el respaldo local con un Ollama de mentira: el umbral de RAM
// se pone a 0 para que el resultado no dependa de la memoria libre del equipo
// que ejecuta las pruebas (en un portátil cargado, el motor local se salta a
// propósito y la prueba fallaría sin que nada esté roto).
process.env.OLLAMA_MIN_FREE_MB = '0';

global.fetch = async (url, options) => {
  const u = String(url);
  seen.push(u);
  // El motor local: levantado, con un modelo ligero.
  if (u.includes('/api/tags')) return respond({ models: [{ name: 'llama3.2:1b' }] });
  if (u.includes('/v1/chat/completions')) {
    const body = JSON.parse(options.body || '{}');
    return respond({ choices: [{ message: { content: 'Contesta el modelo local ' + body.model + '.' } }] });
  }
  // La nube, sin cupo: es el escenario real de un día intenso.
  return respond({ error: { message: 'Rate limit reached for requests per minute.' } }, 429);
};

(async () => {
  const out = {};
  out.cadena = (await engine.getCandidateChain()).map((c) => c.key);

  const res = await engine.runAiText({ systemInstruction: 'x', message: 'hola' });
  out.provider = res.provider;
  out.texto = res.text;
  out.llamadasAlLocal = seen.filter((u) => u.includes('/v1/chat/completions')).length;
  out.cupoJustoConLocal = engine.isQuotaTight();

  // Un turno de FONDO con la nube seca: con motor local NO puede apartarse.
  const fondo = await engine.runAiText({ systemInstruction: 'x', message: 'ronda', priority: 'fondo' });
  out.providerFondo = fondo.provider;

  console.log('RESULTADO ' + JSON.stringify(out));
})().catch((e) => {
  console.log('RESULTADO ' + JSON.stringify({ error: e && e.message }));
});
`;

  let localChild = '';
  try {
    localChild = execFileSync(process.execPath, ['-e', localChildCode], {
      cwd: projectRoot,
      encoding: 'utf8',
    });
  } catch (caught) {
    localChild = `${caught.stdout || ''}${caught.stderr || ''}`;
  }

  const localLine = (localChild || '').split('\n').find((l) => l.startsWith('RESULTADO '));
  let local = null;
  try {
    local = localLine ? JSON.parse(localLine.slice('RESULTADO '.length)) : null;
  } catch {
    local = null;
  }

  check(
    'la prueba del respaldo local se ejecuta y deja su medida',
    local !== null && !local.error,
    (localChild || '').slice(0, 300)
  );
  check(
    'el motor local entra en la cadena, y el ÚLTIMO (la nube primero)',
    Boolean(local) &&
      local.cadena.length >= 2 &&
      local.cadena[0].startsWith('gemini:') &&
      local.cadena[local.cadena.length - 1] === 'ollama:llama3.2:1b',
    local ? local.cadena.join(' → ') : '—'
  );
  check(
    'con la nube sin cupo, el turno lo contesta el modelo local',
    Boolean(local) && local.provider === 'ollama' && /llama3\.2:1b/.test(local.texto || ''),
    local ? `${local.provider} · ${String(local.texto).slice(0, 60)}` : '—'
  );
  check(
    'y lo hace con UNA sola llamada al modelo local',
    Boolean(local) && local.llamadasAlLocal === 1,
    local ? `${local.llamadasAlLocal} llamada(s)` : '—'
  );
  check(
    'con motor local, el cupo NO está justo: el trabajo de fondo sigue',
    Boolean(local) && local.cupoJustoConLocal === false && local.providerFondo === 'ollama',
    local ? `cupoJusto=${local.cupoJustoConLocal} · fondo por ${local.providerFondo}` : '—'
  );
  if (local && !local.error) {
    console.log(
      `   medido: cadena → ${local.cadena.join(' → ')} · turno normal por ${local.provider} · turno de fondo por ${local.providerFondo}`
    );
  }

  /*
   * Y el caso contrario, que es el que no se puede permitir: sin claves y sin
   * motor local. Tiene que decirlo con las DOS salidas delante (una clave gratis
   * o el modelo local) y no prometer una IA que no existe.
   */
  const sinNadaChildCode = `
const path = require('path');
const engine = require(path.join(process.cwd(), '.tmp-verify-ai', 'aiEngine.js'));

delete process.env.GEMINI_API_KEY;
delete process.env.GOOGLE_API_KEY;
delete process.env.GROQ_API_KEY;
delete process.env.AI_PROVIDER;
process.env.OLLAMA_ENABLED = 'auto';

// Nada escuchando en el puerto local.
global.fetch = async () => {
  throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
};

(async () => {
  const out = {};
  out.hasProvider = engine.hasAiProvider();
  out.cadena = (await engine.getCandidateChain()).map((c) => c.key);
  try {
    await engine.runAiText({ systemInstruction: 'x', message: 'hola' });
    out.status = 200;
  } catch (e) {
    out.status = e && e.status;
    out.mensaje = e && e.message;
  }
  console.log('RESULTADO ' + JSON.stringify(out));
})();
`;

  let sinNadaChild = '';
  try {
    sinNadaChild = execFileSync(process.execPath, ['-e', sinNadaChildCode], {
      cwd: projectRoot,
      encoding: 'utf8',
    });
  } catch (caught) {
    sinNadaChild = `${caught.stdout || ''}${caught.stderr || ''}`;
  }

  const sinNadaLine = (sinNadaChild || '').split('\n').find((l) => l.startsWith('RESULTADO '));
  let sinNada = null;
  try {
    sinNada = sinNadaLine ? JSON.parse(sinNadaLine.slice('RESULTADO '.length)) : null;
  } catch {
    sinNada = null;
  }

  check(
    'sin claves ni motor local no se presume de IA',
    Boolean(sinNada) && sinNada.hasProvider === false,
    sinNada ? String(sinNada.hasProvider) : '—'
  );
  check(
    'y el aviso dice las DOS salidas que hay (clave gratis o modelo local)',
    Boolean(sinNada) &&
      sinNada.status === 503 &&
      /GEMINI_API_KEY/.test(sinNada.mensaje || '') &&
      /[Oo]llama/.test(sinNada.mensaje || ''),
    sinNada ? String(sinNada.mensaje).slice(0, 200) : '—'
  );

  /* ---------------------------------------------------------------- */
  /* 12) OpenRouter: la tercera vía cuando los otros dos están secos    */
  /* ---------------------------------------------------------------- */
  /*
   * Gemini y Groq son gratis pero cada uno tiene SU cupo, y un día de estudio
   * intenso los seca a los dos. OpenRouter es un agregador con cuota propia
   * (gratuita) y modelos de otras familias, así que es una tercera vía de verdad
   * y no un modelo más de los mismos.
   *
   * Se comprueba lo que importa de verdad: que esté en el orden pactado, que
   * SOLO use sus modelos gratuitos (`:free`) —los de pago son una factura, no
   * calidad—, que cuando Gemini y Groq están sin cupo lo conteste él, y que una
   * clave rechazada suya no tumbe al proveedor. Su cupo es de la CUENTA (50
   * peticiones al día), no de la clave: por eso no se promete aquí que añadir
   * claves multiplique nada.
   */
  console.log('\n12) OpenRouter: tercera vía de la nube cuando Gemini y Groq están secos');
  console.log('   (su cupo es de la CUENTA: añadir claves no lo multiplica, y la app lo dice así)');

  const openRouterChildCode = `
const path = require('path');
const engine = require(path.join(process.cwd(), '.tmp-verify-ai', 'aiEngine.js'));

process.env.GEMINI_API_KEY = 'clave-gemini';
process.env.GROQ_API_KEY = 'clave-groq';
process.env.OPENROUTER_API_KEY = 'clave-openrouter';
delete process.env.AI_PROVIDER;
// El motor local levantado: así se ve el orden COMPLETO de la cadena.
process.env.OLLAMA_ENABLED = 'auto';
process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

// El catálogo de OpenRouter trae de todo: gratis, de pago y de audio. La app solo
// puede usar los gratuitos y de texto.
const CATALOGO = [
  { id: 'deepseek/deepseek-chat-v3.1:free' },
  { id: 'qwen/qwen3-32b:free' },
  { id: 'openai/gpt-4o' },
  { id: 'whisper-large-v3:free' },
];

const modo = { secos: false };
let chatDetalle = null;
let llamadasOpenRouter = 0;

function json(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  };
}

global.fetch = async (url, options) => {
  const u = String(url);

  if (u.includes('/api/tags')) return json({ models: [{ name: 'llama3.2:1b' }] });

  if (u.includes('generativelanguage')) {
    if (u.includes('/models')) {
      return json({
        models: [
          { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent'] },
        ],
      });
    }
    if (modo.secos) return json({ error: { message: 'You exceeded your current quota, per day' } }, 429);
    return json({ steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Contesta Gemini.' }] }] });
  }

  if (u.includes('groq.com')) {
    if (u.includes('/models')) {
      return json({ data: [{ id: 'openai/gpt-oss-120b' }, { id: 'llama-3.3-70b-versatile' }] });
    }
    if (modo.secos) return json({ error: { message: 'Rate limit reached for requests per day (RPD)' } }, 429);
    return json({ choices: [{ message: { role: 'assistant', content: 'Contesta Groq.' } }] });
  }

  if (u.includes('openrouter.ai')) {
    if (u.includes('/models')) return json({ data: CATALOGO });
    llamadasOpenRouter += 1;
    const body = JSON.parse(options.body || '{}');
    chatDetalle = {
      url: u,
      auth: options.headers.Authorization,
      titulo: options.headers['X-Title'],
      tipo: options.headers['Content-Type'],
      modelo: body.model,
      primerRol: body.messages && body.messages[0] && body.messages[0].role,
      ultimoRol: body.messages && body.messages[body.messages.length - 1] && body.messages[body.messages.length - 1].role,
    };
    return json({
      choices: [{ message: { role: 'assistant', content: 'Contesta OpenRouter con ' + body.model + '.' } }],
    });
  }

  throw new Error('URL inesperada: ' + u);
};

(async () => {
  const out = {};

  // a) El orden pactado, con los cuatro motores disponibles.
  const cadena = await engine.getCandidateChain();
  out.orden = [...new Set(cadena.map((c) => c.key.split(':')[0]))];
  out.modelosDeOpenRouter = cadena.filter((c) => c.provider === 'openrouter').map((c) => c.model);
  out.etiqueta = engine.getConfiguredModelLabel();

  // b) Gemini y Groq secos: el turno lo tiene que contestar OpenRouter.
  modo.secos = true;
  const res = await engine.runAiText({ systemInstruction: 'Eres un catedrático.', message: 'Explícame la derivada.' });
  out.provider = res.provider;
  out.texto = res.text;
  out.endpointChat = chatDetalle ? chatDetalle.url : null;
  out.chat = chatDetalle;
  out.llamadasOpenRouter = llamadasOpenRouter;
  out.rastro = (engine.getLastDecision() ? engine.getLastDecision().attempts : []).map((a) => a.key + ':' + a.outcome);

  // c) El estado: el proveedor aparece, solo con modelos gratis y sin filtrar claves.
  const estado = await engine.getEngineStatus();
  const or = estado.providers.find((p) => p.id === 'openrouter');
  out.proveedor = { configured: or.configured, name: or.name, nota: or.note, disponible: or.keysAvailable };
  out.modelosDelRango = estado.ranked.filter((m) => m.provider === 'openrouter').map((m) => m.model);
  out.algúnModeloDePago = estado.ranked.some((m) => m.provider === 'openrouter' && !m.model.endsWith(':free'));
  out.tieneValorDeClave = JSON.stringify(estado).includes('clave-openrouter');

  console.log('RESULTADO ' + JSON.stringify(out));
})().catch((e) => {
  console.log('RESULTADO ' + JSON.stringify({ error: e && e.message }));
});
`;

  let openRouterChild = '';
  try {
    openRouterChild = execFileSync(process.execPath, ['-e', openRouterChildCode], {
      cwd: projectRoot,
      encoding: 'utf8',
    });
  } catch (caught) {
    openRouterChild = `${caught.stdout || ''}${caught.stderr || ''}`;
  }

  const orLine = (openRouterChild || '').split('\n').find((l) => l.startsWith('RESULTADO '));
  let or = null;
  try {
    or = orLine ? JSON.parse(orLine.slice('RESULTADO '.length)) : null;
  } catch {
    or = null;
  }

  check(
    'la prueba de OpenRouter se ejecuta y deja su medida',
    or !== null && !or.error,
    (openRouterChild || '').slice(0, 300)
  );
  check(
    'el orden pactado de la cadena es Gemini → Groq → OpenRouter → Ollama',
    Boolean(or) && or.orden.join(',') === 'gemini,groq,openrouter,ollama',
    or ? or.orden.join(' → ') : '—'
  );
  check(
    'solo entran sus modelos gratuitos (:free): fuera los de pago y los de audio',
    Boolean(or) &&
      or.modelosDeOpenRouter.length === 2 &&
      or.modelosDeOpenRouter.every((model) => model.endsWith(':free')) &&
      or.modelosDelRango.every((model) => model.endsWith(':free')) &&
      or.algúnModeloDePago === false,
    or ? `cadena: ${or.modelosDeOpenRouter.join(', ')} · en el estado: ${or.modelosDelRango.join(', ')}` : '—'
  );
  check(
    'con Gemini y Groq sin cupo, el turno lo contesta OpenRouter (y con una sola llamada)',
    Boolean(or) &&
      or.provider === 'openrouter' &&
      /^Contesta OpenRouter con /.test(or.texto || '') &&
      or.llamadasOpenRouter === 1,
    or ? `${or.provider} · ${or.llamadasOpenRouter} llamada(s) · ${String(or.texto).slice(0, 60)}` : '—'
  );
  check(
    'por el endpoint compatible con OpenAI, con Bearer, JSON y el system de primero',
    Boolean(or) &&
      or.endpointChat === 'https://openrouter.ai/api/v1/chat/completions' &&
      or.chat.auth === 'Bearer clave-openrouter' &&
      or.chat.tipo === 'application/json' &&
      or.chat.titulo === 'BrainUp Academy' &&
      or.chat.primerRol === 'system' &&
      or.chat.ultimoRol === 'user',
    or ? JSON.stringify(or.chat) : '—'
  );
  check(
    'y el rastro deja ver quién estaba seco y quién respondió',
    Boolean(or) &&
      or.rastro.some((a) => /^gemini:.*:(quota|quota_daily)$/.test(a)) &&
      or.rastro.some((a) => /^groq:.*:(quota|quota_daily)$/.test(a)) &&
      or.rastro.some((a) => /^openrouter:.*:ok$/.test(a)),
    or ? or.rastro.join(' | ') : '—'
  );
  check(
    'OpenRouter aparece configurado en Ajustes, con su nota honesta de cupo por cuenta',
    Boolean(or) &&
      or.proveedor.configured === true &&
      /OpenRouter/.test(or.proveedor.name || '') &&
      /cuenta/i.test(or.proveedor.nota || ''),
    or ? `${or.proveedor.name} · ${String(or.proveedor.nota).slice(0, 140)}` : '—'
  );
  check(
    'el estado del motor no publica el valor de la clave de OpenRouter',
    Boolean(or) && or.tieneValorDeClave === false
  );
  check(
    'la etiqueta del modo nombra los tres proveedores de nube que hay',
    Boolean(or) && or.etiqueta === 'auto (Gemini + Groq + OpenRouter)',
    or ? String(or.etiqueta) : '—'
  );
  if (or && !or.error) {
    console.log(
      `   medido: cadena → ${or.orden.join(' → ')} · con la nube seca contestó ${or.provider} (${or.chat ? or.chat.modelo : '—'})
   rastro: ${or.rastro.join(' | ')}`
    );
  }

  /*
   * Y el caso de la clave rechazada, que en OpenRouter importa igual que en los
   * demás: si su clave principal no vale, el proveedor NO se da por caído (había
   * otra clave utilizable) y el turno sigue. En un proceso aparte para partir de
   * estado limpio.
   */
  const openRouterKeyChildCode = `
const path = require('path');
const engine = require(path.join(process.cwd(), '.tmp-verify-ai', 'aiEngine.js'));

delete process.env.GEMINI_API_KEY;
delete process.env.GROQ_API_KEY;
process.env.OPENROUTER_API_KEY = 'clave-mala';
process.env.OPENROUTER_API_KEY_2 = 'clave-buena';
delete process.env.AI_PROVIDER;
process.env.OLLAMA_ENABLED = 'false';

const usadas = [];

function json(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  };
}

global.fetch = async (url, options) => {
  const u = String(url);
  if (u.includes('/models')) {
    return json({ data: [{ id: 'deepseek/deepseek-chat-v3.1:free' }, { id: 'qwen/qwen3-32b:free' }] });
  }
  const clave = String(options.headers.Authorization || '').replace('Bearer ', '');
  usadas.push(clave);
  if (clave === 'clave-mala') {
    return json({ error: { message: 'No auth credentials found' } }, 401);
  }
  return json({ choices: [{ message: { role: 'assistant', content: 'Contesta la clave buena.' } }] });
};

(async () => {
  const out = {};
  out.hasProvider = engine.hasAiProvider();
  out.clavesLeidas = engine.getProviderKeys('openrouter').map((k) => k.label + ':' + k.envVar);

  const res = await engine.runAiText({ systemInstruction: 'x', message: 'hola' });
  out.provider = res.provider;
  out.texto = res.text;
  out.usadas = usadas.slice();
  out.rastro = (engine.getLastDecision() ? engine.getLastDecision().attempts : []).map((a) => a.key + ':' + a.outcome);

  const estado = await engine.getEngineStatus();
  const or = estado.providers.find((p) => p.id === 'openrouter');
  out.claves = or.keys.map((k) => k.label + ':' + (k.coolingSeconds > 0 ? 'enfriada' : 'disponible') + ':' + k.lastStatus);
  out.disponibles = or.keysAvailable;
  out.extra = or.extraKeyEnv;
  out.tieneValorDeClave = JSON.stringify(estado).includes('clave-mala') || JSON.stringify(estado).includes('clave-buena');

  console.log('RESULTADO ' + JSON.stringify(out));
})().catch((e) => {
  console.log('RESULTADO ' + JSON.stringify({ error: e && e.message }));
});
`;

  let orKeyChild = '';
  try {
    orKeyChild = execFileSync(process.execPath, ['-e', openRouterKeyChildCode], {
      cwd: projectRoot,
      encoding: 'utf8',
    });
  } catch (caught) {
    orKeyChild = `${caught.stdout || ''}${caught.stderr || ''}`;
  }

  const orKeyLine = (orKeyChild || '').split('\n').find((l) => l.startsWith('RESULTADO '));
  let orKey = null;
  try {
    orKey = orKeyLine ? JSON.parse(orKeyLine.slice('RESULTADO '.length)) : null;
  } catch {
    orKey = null;
  }

  check(
    'sin Gemini ni Groq, con clave de OpenRouter ya hay IA disponible',
    Boolean(orKey) && orKey.hasProvider === true && orKey.provider === 'openrouter',
    orKey ? `hasProvider=${orKey.hasProvider} · ${orKey.provider}` : '—'
  );
  check(
    'las claves extra de OpenRouter se leen con su etiqueta',
    Boolean(orKey) &&
      orKey.clavesLeidas.join(',') === 'principal:OPENROUTER_API_KEY,2:OPENROUTER_API_KEY_2',
    orKey ? orKey.clavesLeidas.join(',') : '—'
  );
  check(
    'una clave rechazada (401) no tumba al proveedor: contesta la siguiente',
    Boolean(orKey) && orKey.texto === 'Contesta la clave buena.' && orKey.usadas.join(',') === 'clave-mala,clave-buena',
    orKey ? `${orKey.usadas.join(' → ')} · ${orKey.texto}` : '—'
  );
  check(
    'y el rastro distingue la clave mala de la que respondió',
    Boolean(orKey) &&
      orKey.rastro.some((a) => /#principal:auth$/.test(a)) &&
      orKey.rastro.some((a) => /#2:ok$/.test(a)),
    orKey ? orKey.rastro.join(' | ') : '—'
  );
  check(
    'el estado enseña la clave rechazada enfriada sin exponer su valor',
    Boolean(orKey) &&
      orKey.claves.some((k) => k.startsWith('principal:enfriada:auth')) &&
      orKey.disponibles === 1 &&
      orKey.tieneValorDeClave === false,
    orKey ? `${orKey.claves.join(', ')} · disponibles: ${orKey.disponibles}` : '—'
  );
  if (orKey && !orKey.error) {
    console.log(`   medido: claves de OpenRouter → ${orKey.usadas.join(' → ')} · ${orKey.claves.join(', ')}`);
  }

  /*
   * Un prompt que NO CABE en el modelo no es un fallo transitorio.
   *
   * Groq devuelve 502 con «Request too large … tokens per minute (ITPM): Limit
   * 7000, Requested 9000». Antes se trataba como caída del proveedor: el mismo
   * prompt de 9k tokens se mandaba tres veces con espera entre medias y el turno
   * perdía segundos para acabar igual, en otro modelo. Ahora se reconoce por su
   * texto, no se reintenta y se pasa al de al lado UNA vez.
   *
   * En un proceso aparte para partir de un motor recién arrancado (sin
   * enfriamientos de las pruebas anteriores).
   */
  const tooLargeChildCode = `
const path = require('path');
const engine = require(path.join(process.cwd(), '.tmp-verify-ai', 'aiEngine.js'));

delete process.env.GEMINI_API_KEY;
delete process.env.OPENROUTER_API_KEY;
delete process.env.AI_PROVIDER;
process.env.GROQ_API_KEY = 'clave-prueba';
process.env.OLLAMA_ENABLED = 'false';

const llamadas = [];

function json(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  };
}

global.fetch = async (url, options) => {
  const u = String(url);
  if (u.includes('/models')) {
    return json({ data: [{ id: 'openai/gpt-oss-120b' }, { id: 'openai/gpt-oss-20b' }] });
  }
  const body = JSON.parse(options.body || '{}');
  llamadas.push(body.model);
  if (body.model === 'openai/gpt-oss-120b') {
    return json(
      {
        error: {
          message:
            'Request too large for model gpt-oss-120b in organization org_x service tier on_demand on input tokens per minute (ITPM): Limit 7000, Requested 9000, please reduce your message size',
        },
      },
      502
    );
  }
  return json({ choices: [{ message: { role: 'assistant', content: 'Contesta el segundo modelo.' } }] });
};

(async () => {
  const out = {};
  const inicio = Date.now();
  const res = await engine.runAiText({ systemInstruction: 'x', message: 'hola' });
  out.ms = Date.now() - inicio;
  out.modelo = res.model;
  out.texto = res.text;
  out.llamadas = llamadas.slice();
  const decision = engine.getLastDecision();
  out.rastro = (decision ? decision.attempts : []).map((a) => a.key + ':' + a.outcome);
  const estado = await engine.getEngineStatus();
  const primero = (estado.ranked || []).find((m) => m.model === 'openai/gpt-oss-120b');
  out.estado = primero ? primero.lastStatus : null;
  out.enfriado = primero ? primero.coolingSeconds : null;
  console.log('RESULTADO ' + JSON.stringify(out));
})().catch((e) => {
  console.log('RESULTADO ' + JSON.stringify({ error: e && e.message }));
});
`;

  let tooLargeChild = '';
  try {
    tooLargeChild = execFileSync(process.execPath, ['-e', tooLargeChildCode], {
      cwd: projectRoot,
      encoding: 'utf8',
    });
  } catch (caught) {
    tooLargeChild = `${caught.stdout || ''}${caught.stderr || ''}`;
  }

  const tooLargeLine = (tooLargeChild || '').split('\n').find((l) => l.startsWith('RESULTADO '));
  let tooLarge = null;
  try {
    tooLarge = tooLargeLine ? JSON.parse(tooLargeLine.slice('RESULTADO '.length)) : null;
  } catch {
    tooLarge = null;
  }

  console.log('\n13) Un prompt que no cabe en el modelo no se reintenta');
  check(
    'el modelo que no admite el tamaño se prueba UNA sola vez',
    Boolean(tooLarge) && tooLarge.llamadas.filter((m) => m === 'openai/gpt-oss-120b').length === 1,
    tooLarge ? tooLarge.llamadas.join(' → ') : '—'
  );
  check(
    'y el turno sigue con el siguiente modelo en vez de rendirse',
    Boolean(tooLarge) && tooLarge.modelo === 'openai/gpt-oss-20b' && tooLarge.texto === 'Contesta el segundo modelo.',
    tooLarge ? `${tooLarge.modelo} · ${tooLarge.texto}` : '—'
  );
  check(
    'el rastro lo anota como «too_large», no como caída del proveedor',
    Boolean(tooLarge) && tooLarge.rastro.some((a) => /:too_large$/.test(a)),
    tooLarge ? tooLarge.rastro.join(' | ') : '—'
  );
  check(
    'el modelo queda apartado un rato (para no repetir la misma petición en cada turno)',
    Boolean(tooLarge) && tooLarge.estado === 'too_large' && tooLarge.enfriado > 0,
    tooLarge ? `${tooLarge.estado} · ${tooLarge.enfriado} s` : '—'
  );
  if (tooLarge && !tooLarge.error) {
    console.log(`   medido: ${tooLarge.llamadas.join(' → ')} · ${tooLarge.ms} ms en total`);
  }

  /*
   * El prompt que SÍ cabe después de recortarlo.
   *
   * El caso real: Gemini saturado, Groq sano y un PDF que ocupa 45 000
   * caracteres. Groq rechaza la petición entera por ITPM y el alumno se queda
   * sin IA. Ahora el motor recorta el bloque de documentos antes de llamar y, si
   * aun así no cabe, aprieta el recorte y reintenta el MISMO modelo.
   *
   * En un proceso aparte para partir de un motor limpio.
   */
  const compactChildCode = `
const path = require('path');
const engine = require(path.join(process.cwd(), '.tmp-verify-ai', 'aiEngine.js'));

delete process.env.GEMINI_API_KEY;
delete process.env.OPENROUTER_API_KEY;
process.env.GROQ_API_KEY = 'clave-prueba';
process.env.AI_PROVIDER = 'groq';
process.env.OLLAMA_ENABLED = 'false';

const calls = [];
function json(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body };
}
global.fetch = async (url, options) => {
  const u = String(url);
  if (u.includes('/models')) return json({ data: [{ id: 'openai/gpt-oss-120b' }] });
  const body = JSON.parse(options.body || '{}');
  calls.push(body);
  const system = (body.messages || []).find((m) => m.role === 'system');
  const systemText = system ? String(system.content) : '';
  if (systemText.length > 15000) {
    return json({ error: { message: 'Request too large for model gpt-oss-120b on input tokens per minute (ITPM): Limit 7000, Requested 12000, please reduce your message size' } }, 502);
  }
  return json({ choices: [{ message: { role: 'assistant', content: 'respuesta compacta' } }] });
};

(async () => {
  const system =
    'DOCUMENTOS QUE TE HA DADO EL ALUMNO\\n' +
    'x'.repeat(50000) +
    '\\nPROTOCOLO SOCRÁTICO\\nfinal';
  const res = await engine.runAiText({
    systemInstruction: system,
    message: '¿De qué va el documento? ' + 'y'.repeat(2500),
  });
  const decision = engine.getLastDecision();
  console.log('RESULTADO ' + JSON.stringify({
    calls: calls.length,
    systemLens: calls.map((body) => String(((body.messages || []).find((m) => m.role === 'system') || {}).content || '').length),
    text: res.text,
    trace: (decision ? decision.attempts : []).map((a) => a.outcome),
  }));
})().catch((e) => console.log('RESULTADO ' + JSON.stringify({ error: e && e.message })));
`;

  let compactChild = '';
  try {
    compactChild = execFileSync(process.execPath, ['-e', compactChildCode], {
      cwd: projectRoot,
      encoding: 'utf8',
    });
  } catch (caught) {
    compactChild = `${caught.stdout || ''}${caught.stderr || ''}`;
  }

  const compactLine = (compactChild || '').split('\n').find((l) => l.startsWith('RESULTADO '));
  let compact = null;
  try {
    compact = compactLine ? JSON.parse(compactLine.slice('RESULTADO '.length)) : null;
  } catch {
    compact = null;
  }

  console.log('\n14) Un prompt grande se ajusta al límite de Groq en vez de reventar');
  check(
    'el primer intento ya va recortado (no se manda el PDF entero)',
    Boolean(compact) && compact.systemLens[0] > 0 && compact.systemLens[0] <= 17000,
    compact ? `sistema: ${compact.systemLens.join(' → ')} caracteres` : '—'
  );
  check(
    'si aun así no cabe, se recorta más y se reintenta el MISMO modelo',
    Boolean(compact) && compact.calls === 2 && compact.systemLens[1] < compact.systemLens[0],
    compact ? `llamadas: ${compact.calls} · ${compact.systemLens.join(' → ')}` : '—'
  );
  check(
    'y el turno acaba contestando, no en «saturación»',
    Boolean(compact) && compact.text === 'respuesta compacta',
    compact ? compact.text : '—'
  );
  if (compact && !compact.error) {
    console.log(`   medido: ${compact.systemLens.join(' → ')} caracteres de sistema · ${compact.calls} llamada(s)`);
  }

  /*
   * Adjuntos en proveedores que no son Gemini: una captura se manda como
   * imagen SOLO a un modelo con visión; un PDF cuyo texto ya está en el prompt
   * no se marca como «no leído». Y en un modelo sin visión se avisa, sin fingir.
   */
  const visionChildCode = `
const path = require('path');
const engine = require(path.join(process.cwd(), '.tmp-verify-ai', 'aiEngine.js'));

delete process.env.GEMINI_API_KEY;
delete process.env.GROQ_API_KEY;
process.env.OPENROUTER_API_KEY = 'clave-prueba';
process.env.AI_PROVIDER = 'openrouter';
process.env.OLLAMA_ENABLED = 'false';

let lastBody = null;
function json(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body };
}
global.fetch = async (url, options) => {
  const u = String(url);
  if (u.includes('/models')) return json({ data: [{ id: 'qwen/qwen2.5-vl-72b-instruct:free' }] });
  lastBody = JSON.parse(options.body || '{}');
  return json({ choices: [{ message: { role: 'assistant', content: 'veo la captura' } }] });
};

(async () => {
  const attachment = {
    name: 'captura.png',
    mimeType: 'image/png',
    data: Buffer.from('png-de-prueba').toString('base64'),
  };
  const pdf = {
    name: 'doc.pdf',
    mimeType: 'application/pdf',
    data: Buffer.from('%PDF-1.4').toString('base64'),
  };
  const res = await engine.runAiText({
    systemInstruction: 'DOCUMENTOS QUE TE HA DADO EL ALUMNO\\nEl PDF «doc.pdf» trata de energía.\\nPROTOCOLO SOCRÁTICO',
    message: '¿Qué se ve en la captura?',
    attachments: [attachment, pdf],
    readableTextAttachments: ['doc.pdf'],
  });
  const last = (lastBody.messages || [])[lastBody.messages.length - 1];
  const content = last ? last.content : null;
  console.log('RESULTADO ' + JSON.stringify({
    model: res.model,
    isArray: Array.isArray(content),
    hasImage: Array.isArray(content) && content.some((p) => p.type === 'image_url' && String(p.image_url.url).startsWith('data:image/png;base64,')),
    text: Array.isArray(content) ? content.filter((p) => p.type === 'text').map((p) => p.text).join(' ') : String(content || ''),
    reply: res.text,
  }));
})().catch((e) => console.log('RESULTADO ' + JSON.stringify({ error: e && e.message })));
`;

  let visionChild = '';
  try {
    visionChild = execFileSync(process.execPath, ['-e', visionChildCode], {
      cwd: projectRoot,
      encoding: 'utf8',
    });
  } catch (caught) {
    visionChild = `${caught.stdout || ''}${caught.stderr || ''}`;
  }

  const visionLine = (visionChild || '').split('\n').find((l) => l.startsWith('RESULTADO '));
  let vision = null;
  try {
    vision = visionLine ? JSON.parse(visionLine.slice('RESULTADO '.length)) : null;
  } catch {
    vision = null;
  }

  console.log('\n15) Adjuntos fuera de Gemini: imagen al modelo con visión y texto del PDF sin avisos falsos');
  check(
    'la captura viaja como image_url en data URL',
    Boolean(vision) && vision.hasImage === true,
    vision ? JSON.stringify(vision).slice(0, 200) : '—'
  );
  check(
    'el PDF cuyo texto ya está en el prompt NO se marca como no leído',
    Boolean(vision) && !/NO puede leer archivos/i.test(vision.text),
    vision ? String(vision.text).slice(0, 220) : '—'
  );
  check(
    'y el modelo multimodal contesta',
    Boolean(vision) && String(vision.reply || '').includes('veo la captura'),
    vision ? JSON.stringify(vision).slice(0, 400) : '—'
  );

  delete process.env.GROQ_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY_2;
  delete process.env.GEMINI_API_KEY_3;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY_2;
  delete process.env.AI_PROVIDER;

  console.log(failures === 0 ? '\nTODO EN VERDE' : `\n${failures} COMPROBACIONES FALLIDAS`);
  fs.rmSync(outDir, { recursive: true, force: true });
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((caught) => {
  console.error('FALLO INESPERADO:', caught);
  fs.rmSync(outDir, { recursive: true, force: true });
  process.exitCode = 1;
});
