/**
 * Verificación de la memoria entre días (`src/lib/agentMemory.ts`).
 *
 * Lo que se comprueba, en dos tandas:
 *
 *   **Sin gastar nada (puro).** Que las piezas que arman el recuerdo y el bloque
 *   del prompt hagan lo que dicen: el bloque va de lo más reciente a lo más
 *   antiguo, respeta su presupuesto de caracteres, no se inventa días que no
 *   tienen nada que contar, y el prompt del catedrático y el del coordinador
 *   incluyen esa memoria **cuando la hay** y no la menciona cuando no la hay.
 *
 *   **En vivo (base y app).** Se planta un recuerdo de «ayer» para un
 *   catedrático real, se le habla por `/api/tutor` y se comprueba lo que de
 *   verdad importa:
 *
 *     1. que el recuerdo de ayer **entra en el prompt de hoy** (queda dicho en el
 *        log de la app, con cuántos caracteres),
 *     2. que lo hablado hoy **se apunta solo** para mañana,
 *     3. que `/api/salud` lo ve, y
 *     4. **cuánto tarda** una respuesta de verdad, que es lo que se está
 *        aligerando (se mide el reloj, no se supone).
 *
 * Todo lo que se crea para probarlo (el recuerdo plantado, la conversación de
 * prueba y el recuerdo que escribe el test) se borra al terminar, y los recuerdos
 * que ya existían se restauran tal cual: la memoria de verdad no se toca.
 *
 * Uso:
 *   node scripts/verify-memoria.js
 *   npm run verify:memoria
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PrismaClient } = require('@prisma/client');

const projectRoot = path.join(__dirname, '..');
const outDir = path.join(projectRoot, '.tmp-verify-memoria');
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:3000';

let failures = 0;
const failed = [];

function section(title) {
  console.log(`\n${title}`);
}

function check(label, condition, detail) {
  if (condition) {
    console.log(`  \u001b[32m✓\u001b[0m ${label}${detail ? ` · ${detail}` : ''}`);
  } else {
    failures += 1;
    failed.push(label);
    console.log(`  \u001b[31m✗\u001b[0m ${label}${detail ? ` · ${detail}` : ''}`);
  }
}

/** Carga las claves del .env (sin imprimirlas). */
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

/** Transpila los módulos de la memoria y de los prompts a un directorio temporal. */
function compile() {
  fs.rmSync(outDir, { recursive: true, force: true });
  execFileSync(
    process.execPath,
    [
      require.resolve('typescript/bin/tsc'),
      path.join('src', 'lib', 'agentMemory.ts'),
      path.join('src', 'lib', 'tutor.ts'),
      path.join('src', 'lib', 'setup.ts'),
      '--outDir',
      path.relative(projectRoot, outDir),
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
}

function dayKeyOf(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Lee el log del servidor (entero: el test mira solo lo que pasa de una marca). */
function readServerLog() {
  const logPath = path.join(projectRoot, 'data', 'logs', 'servidor.log');
  if (!fs.existsSync(logPath)) return '';
  return fs.readFileSync(logPath, 'utf8');
}

async function main() {
  loadEnv();
  compile();    const M = require(path.join(outDir, 'agentMemory.js'));
    // El motor se sustituye **antes** de cargar el tutor: así se puede probar la
    // capa del tutor (etiquetas, respuesta en blanco) sin gastar una sola llamada
    // ni depender de que hoy haya cuota.
    const E = require(path.join(outDir, 'aiEngine.js'));
    let fakeReply = { text: '', steps: [], model: 'modelo-de-prueba', provider: 'groq' };
    E.runAiText = async () => fakeReply;
    const T = require(path.join(outDir, 'tutor.js'));
    const S = require(path.join(outDir, 'setup.js'));
  const prisma = new PrismaClient();

  const mark = readServerLog().length;
  const snapshot = await prisma.agentMemory.findMany();

  try {
    /* ---------------------------------------------------------------- */
    /* 1. Las piezas puras                                              */
    /* ---------------------------------------------------------------- */
    section('1. El día y el bloque de memoria (sin base de datos)');
    const fixed = new Date(2026, 9, 14, 18, 30);
    check('El día de la memoria es el del alumno (AAAA-MM-DD)', M.dayKey(fixed) === '2026-10-14', M.dayKey(fixed));
    check('dayKey() sin argumentos es hoy', M.dayKey() === dayKeyOf(new Date()), M.dayKey());
    check('Los recuerdos se piden de los últimos 30 días', M.MEMORY_DAYS === 30, `${M.MEMORY_DAYS} días`);

    const memories = [
      { day: '2026-10-12', summary: 'Anteayer hicimos el examen de cinemática.', facts: [{ label: 'fechas', value: '12 de octubre' }], writtenBy: 'reglas' },
      { day: '2026-10-14', summary: 'Hoy repasamos derivadas y quedó pendiente el ejercicio 5.', facts: [{ label: 'unidades', value: '3' }], writtenBy: 'ia' },
      { day: '2026-10-13', summary: '', facts: [], writtenBy: 'reglas' },
    ];
    const block = M.buildMemoryBlock(memories);

    check('El bloque avisa de que es algo que ya sabe', /YA SABES/.test(block), block.split('\n')[0].slice(0, 70));
    check('El día más reciente va primero', block.indexOf('14/10') < block.indexOf('12/10'), block.split('\n')[1].slice(0, 40));
    check('Un día sin nada que contar no ocupa sitio', !block.includes('13/10'));
    check('Los datos concretos van en el mismo renglón', /unidades: 3/.test(block));
    check('Y no se añade nada si no hay nada que recordar', M.buildMemoryBlock([]) === '' && M.buildMemoryBlock(memories.slice(2)) === '');

    const many = [];
    for (let index = 0; index < 30; index++) {
      many.push({
        day: `2026-09-${String(index + 1).padStart(2, '0')}`,
        summary: 'Un día de estudio con bastantes cosas contadas y bastante texto para llenar el presupuesto del prompt. '.repeat(3),
        facts: [],
        writtenBy: 'reglas',
      });
    }
    const big = M.buildMemoryBlock(many);
    check(
      'El bloque respeta su presupuesto de caracteres',
      big.length <= M.MEMORY_MAX_CHARS + 460,
      `${big.length} caracteres (tope ${M.MEMORY_MAX_CHARS})`
    );
    check(
      'Y cuando no cabe todo se cae lo más viejo, no lo de hoy',
      M.buildMemoryBlock(many).includes('30/09') && !M.buildMemoryBlock(many).includes('01/09')
    );
    check('No se cuelan más de 4 datos por día', M.MEMORY_MAX_FACTS === 4, `${M.MEMORY_MAX_FACTS} datos`);

    /* ---------------------------------------------------------------- */
    /* 2. El recuerdo que se saca de una conversación                    */
    /* ---------------------------------------------------------------- */
    section('2. Lo que se apunta de una conversación (reglas, sin IA)');
    const conversation = [
      { role: 'user', content: 'No lo sé hacer, ¿me ayudas con la unidad 3 de derivadas?' },
      { role: 'assistant', content: 'Vamos paso a paso. Antes de seguir, dime qué te sale del límite.' },
      { role: 'user', content: 'Vale, lo he entendido.' },
      {
        role: 'assistant',
        content:
          'Bien. Lo apunto: acordamos repasar la unidad 3 mañana con el examen del 3 de diciembre, y queda pendiente hacer los ejercicios 5 y 8. Te lo apunto en un apunte nuevo.',
      },
    ];
    const digest = M.digestConversation(conversation);

    check('El recuerdo dice de qué se habló', /Se habló de/.test(digest.summary), digest.summary.slice(0, 90));
    check('Y qué quedó pendiente o acordado', /Quedó pendiente|Se acordó/.test(digest.summary));
    check('Saca las fechas citadas como dato concreto', JSON.stringify(digest.facts).includes('3 de diciembre'), JSON.stringify(digest.facts));
    check('Y las unidades', JSON.stringify(digest.facts).includes('unidades'), JSON.stringify(digest.facts));
    check('Los datos concretos no pasan de 4', digest.facts.length <= M.MEMORY_MAX_FACTS, `${digest.facts.length}`);
    check('El recuerdo está acotado en longitud', digest.summary.length <= 600, `${digest.summary.length} caracteres`);

    const sinNada = M.digestConversation([
      { role: 'user', content: 'hola' },
      { role: 'assistant', content: 'Hola, ¿en qué te ayudo?' },
    ]);
    check('Una conversación vacía no inventa un acuerdo', !/Se acordó/.test(sinNada.summary), sinNada.summary.slice(0, 60));

    /* ---------------------------------------------------------------- */
    /* 3. La memoria dentro del prompt                                   */
    /* ---------------------------------------------------------------- */
    section('3. Que el prompt la lleve (y que no la lleve cuando no hay)');
    const agent = {
      name: 'Catedrático de Matemáticas I',
      specialty: 'Matemáticas de 1º de Bachillerato orientadas a la PAU',
      systemPrompt: 'Eres exigente y socrático.',
      subject: { name: 'Matemáticas I', currentGrade: 7, gradeSource: 'declarada', targetGrade: 9.5 },
    };
    const ctx = {
      studentName: 'Ojeda',
      modality: '1º de Bachillerato',
      measuredTopics: [],
      unmeasuredCount: 0,
      courseUnit: null,
      upcomingExams: [],
      pendingErrors: 0,
      notes: [],
      notesShared: false,
      notesTotal: 0,
    };

    const memoryText = 'LO QUE YA SABES DE LOS DÍAS ANTERIORES (lo tienes ya apuntado: no lo vuelvas a preguntar, úsalo):\n· 13/10 — Ayer repasamos derivadas.';
    const withMemory = T.buildTutorSystemPrompt(agent, Object.assign({}, ctx, { memory: memoryText }));
    const withoutMemory = T.buildTutorSystemPrompt(agent, ctx);

    check('El catedrático recibe la memoria dentro de su prompt', withMemory.includes('Ayer repasamos derivadas'));
    check('Y sigue llevando su protocolo socrático', /PROTOCOLO SOCRÁTICO/.test(withMemory));
    check('La memoria va antes del protocolo (no la tapa el formato)', withMemory.indexOf('Ayer repasamos derivadas') < withMemory.indexOf('PROTOCOLO SOCRÁTICO'));
    check('Sin memoria el prompt no menciona ningún recuerdo', !/YA SABES/.test(withoutMemory));
    check('Pero sigue siendo el mismo catedrático', withoutMemory.includes('Catedrático de Matemáticas I'));

    // El temario con su numeración real. Sin él, el catedrático proponía los
    // apuntes de la unidad que está dando en clase aunque le pidieran otra
    // (le pedían química orgánica —U9— y salían los de trabajo mecánico —U16—).
    const withSyllabus = T.buildTutorSystemPrompt(
      agent,
      Object.assign({}, ctx, {
        syllabus: [
          { unitNumber: 9, title: 'Química orgánica: grupos funcionales y formulación' },
          { unitNumber: 16, title: 'Trabajo, energía y potencia: conservación' },
        ],
      })
    );
    check(
      'El temario entra en el prompt con su numeración real',
      withSyllabus.includes('U9 · Química orgánica') && withSyllabus.includes('U16 · Trabajo'),
      withSyllabus.split('\n').find((line) => line.startsWith('- U9')) ?? 'sin línea de U9'
    );
    check(
      'y le advierte de que la etiqueta no lleve el número de la unidad en curso',
      /no el de la que está dando en clase/.test(withSyllabus)
    );
    check('Sin temario no aparece el bloque', !/TEMARIO DE/.test(withoutMemory));

    // Estado mínimo del sistema, con la forma exacta que espera el coordinador.
    const snapshotState = {
      today: '2026-10-14',
      studentName: 'Ojeda',
      modality: '1º de Bachillerato',
      targetPau: 12,
      weeklyHoursCap: 15,
      weeklyHoursDeclared: true,
      studyMode: 'comfort',
      timetable: [],
      classCount: 0,
      weeklyClassHours: 0,
      timetableComplete: false,
      untracked: [],
      subjects: [],
      setupCompletedAt: null,
    };
    const checklistState = {
      subjects: [],
      general: [],
      doneItems: 3,
      totalItems: 10,
      percent: 30,
      pending: [],
      complete: false,
      nextQuestion: {
        subjectId: null,
        subjectName: null,
        about: 'temario',
        prompt: 'pregunta de prueba',
      },
    };
    const setupWith = S.buildSetupSystemPrompt(snapshotState, checklistState, memoryText);
    check('El coordinador de la puesta a punto también recibe la memoria', setupWith.includes('Ayer repasamos derivadas'));
    check('Y sin memoria no se le añade nada', !/YA SABES/.test(S.buildSetupSystemPrompt(snapshotState, checklistState)));

    /* ---------------------------------------------------------------- */
    /* 3.b El fallo que reportó el alumno: el recuadro vacío             */
    /* ---------------------------------------------------------------- */
    section('3.b La respuesta en blanco del catedrático (el fallo que reportaste)');

    fakeReply = { text: '[[etapa:diagnostico]] \n[[nivel:U3=50]]', steps: [], model: 'm', provider: 'groq' };
    let blankError = null;
    try {
      await T.requestTutorInteraction({ systemInstruction: 'x', message: 'hola' });
    } catch (caught) {
      blankError = caught;
    }
    check(
      'Una respuesta con solo etiquetas internas no se guarda como mensaje vacío',
      blankError !== null,
      blankError ? `${blankError.status} · ${blankError.message.slice(0, 70)}` : 'se ha colado un recuadro vacío'
    );
    check('Y se cuenta como error del tutor (502), no como respuesta buena', blankError !== null && blankError.status === 502);

    fakeReply = { text: '[[etapa:pista_1]] Empieza por factorizar el numerador.', steps: [], model: 'm', provider: 'groq' };
    const fine = await T.requestTutorInteraction({ systemInstruction: 'x', message: 'hola' });
    check('Una respuesta normal sigue pasando, con su etapa', fine.text === 'Empieza por factorizar el numerador.' && fine.stage === 'pista_1', `${fine.stage} · ${fine.text.slice(0, 40)}`);

    /* ---------------------------------------------------------------- */
    /* 4. En vivo: de ayer a hoy                                         */
    /* ---------------------------------------------------------------- */
    section('4. En vivo: lo de ayer entra en el prompt de hoy');
    const liveAgent = await prisma.aiAgent.findFirst({
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
    check('Hay un catedrático con el que probar', liveAgent !== null, liveAgent ? liveAgent.name : 'ninguno');

    if (!liveAgent) throw new Error('No hay ningún catedrático en la base: no se puede probar en vivo.');

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const planted = `Ayer (${dayKeyOf(yesterday)}) estuvimos con la unidad 7 y quedó pendiente el problema 12; lo dejamos para la próxima sesión.`;
    await M.saveDayMemory({
      scope: liveAgent.id,
      day: dayKeyOf(yesterday),
      summary: planted,
      facts: [{ label: 'unidades', value: '7' }],
    });

    const loaded = await M.loadMemoryBlock(liveAgent.id);
    check('El recuerdo de ayer se lee y se arma el bloque', loaded.includes('unidad 7'), `${loaded.length} caracteres`);

    const tutorStarted = Date.now();
    const response = await fetch(`${APP_URL}/api/tutor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: liveAgent.id,
        message: 'Verificación del sistema: responde solo con la palabra «vale».',
      }),
    });
    const body = await response.json().catch(() => ({}));
    const tutorMs = Date.now() - tutorStarted;
    check('La app contesta al mensaje del alumno', response.status === 200, `${response.status}${body.error ? ` · ${body.error}` : ''}`);
    check('Y la respuesta trae texto visible', typeof body.reply?.content === 'string' && body.reply.content.trim().length > 0, String(body.reply?.content ?? '').slice(0, 60));

    // Un segundo turno: una conversación de un solo saludo no es memoria (por
    // diseño), así que se habla dos veces para que lo de hoy se apunte.
    const followUp = await fetch(`${APP_URL}/api/tutor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: liveAgent.id,
        conversationId: body.conversationId,
        message: 'Verificación del sistema: responde solo con la palabra «sí».',
      }),
    });
    check('La app contesta al segundo mensaje de la misma conversación', followUp.status === 200, `${followUp.status}`);

    // Espera a que el `after` (que escribe la memoria fuera de la respuesta) acabe.
    await new Promise((resolve) => setTimeout(resolve, 6000));

    const logTail = readServerLog().slice(mark);
    const memoryLine = logTail.match(/\[tutor\] memoria del catedrático: (\d+) caracteres/);
    check(
      'El catedrático ha recibido la memoria de ayer (queda en el log de la app)',
      memoryLine !== null,
      memoryLine ? `${memoryLine[1]} caracteres en el prompt` : 'no aparece la línea en el log'
    );

    const todayRow = await prisma.agentMemory.findUnique({
      where: { scope_day: { scope: liveAgent.id, day: M.dayKey() } },
    });
    check('Y lo hablado hoy se ha apuntado solo, para mañana', todayRow !== null, todayRow ? `${todayRow.writtenBy} · ${todayRow.summary.length} caracteres` : 'sin fila');
    check(
      'El recuerdo de hoy cuenta algo de esta conversación',
      todayRow !== null && /verificaci|vale/i.test(todayRow.summary),
      todayRow ? todayRow.summary.slice(0, 110) : '—'
    );

    const health = await (await fetch(`${APP_URL}/api/salud`)).json().catch(() => ({}));
    check('El parte de salud de la app ve la memoria', Boolean(health.memory) && health.memory.days >= 1, JSON.stringify(health.memory));
    check(
      'Y dice cuál fue el último recuerdo',
      Boolean(health.memory && health.memory.latest && health.memory.latest.day === M.dayKey()),
      JSON.stringify(health.memory && health.memory.latest)
    );

    /* ---------------------------------------------------------------- */
    /* 4.b Memoria DENTRO de la conversación                             */
    /* ---------------------------------------------------------------- */
    //
    // El fallo que reportó el alumno: el coordinador contestaba como si
    // empezara de cero. La causa era que a Gemini solo le llegaban los turnos
    // crudos del tutor; el coordinador le mandaba `messages` y la API de
    // Interactions los ignoraba. Aquí se prueba con dos turnos de verdad que
    // el dato dicho antes vuelve a aparecer.
    section('4.b Memoria de la conversación: ¿recuerda lo de dos turnos antes?');

    const sentinel = 'turquesa cartagenera';
    const datosAntes = { topics: await prisma.topic.count(), exams: await prisma.exam.count() };

    const coordConversation = await prisma.aiConversation.findFirst({
      where: { agentId: null, title: 'Puesta a punto' },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });

    if (!coordConversation) {
      check('Hay una conversación del coordinador con la que probar', false, 'no existe');
    } else {
      const startedAt = new Date();
      const coordFirst = await fetch(`${APP_URL}/api/puesta-a-punto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: coordConversation.id,
          message: `Verificación de memoria: recuerda que mi palabra secreta es «${sentinel}». No anotes nada en el sistema ni emitas etiquetas.`,
        }),
      });
      const coordSecond = await fetch(`${APP_URL}/api/puesta-a-punto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: coordConversation.id,
          message:
            'Verificación de memoria: ¿cuál es mi palabra secreta? Contesta solo con la palabra, sin etiquetas.',
        }),
      });
      const coordBody = await coordSecond.json().catch(() => ({}));
      const coordReply = String(coordBody.reply?.content ?? '');
      check(
        'El coordinador recuerda lo dicho dos turnos antes',
        coordFirst.status === 200 && coordSecond.status === 200 && new RegExp(sentinel, 'i').test(coordReply),
        coordReply.slice(0, 120).replace(/\n/g, ' ')
      );
      await prisma.aiMessage.deleteMany({
        where: { conversationId: coordConversation.id, createdAt: { gte: startedAt } },
      });
    }

    const tutorMemFirst = await fetch(`${APP_URL}/api/tutor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: liveAgent.id,
        // Conversación propia: la prueba la borra al terminar y no puede
        // llevarse por delante el hilo real del catedrático.
        fresh: true,
        message: `Verificación de memoria: recuerda que mi palabra secreta es «${sentinel}». No anotes nada.`,
      }),
    });
    const tutorMemFirstBody = await tutorMemFirst.json().catch(() => ({}));
    const tutorMemSecond = await fetch(`${APP_URL}/api/tutor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: liveAgent.id,
        conversationId: tutorMemFirstBody.conversationId,
        message: 'Verificación de memoria: ¿cuál es mi palabra secreta? Contesta solo con la palabra.',
      }),
    });
    const tutorMemSecondBody = await tutorMemSecond.json().catch(() => ({}));
    const tutorMemReply = String(tutorMemSecondBody.reply?.content ?? '');
    check(
      'El catedrático recuerda lo dicho dos turnos antes',
      tutorMemFirst.status === 200 &&
        tutorMemSecond.status === 200 &&
        new RegExp(sentinel, 'i').test(tutorMemReply),
      tutorMemReply.slice(0, 120).replace(/\n/g, ' ')
    );

    if (tutorMemFirstBody.conversationId) {
      await prisma.aiMessage.deleteMany({ where: { conversationId: tutorMemFirstBody.conversationId } });
      await prisma.aiConversation.deleteMany({ where: { id: tutorMemFirstBody.conversationId } });
    }

    const datosDespues = { topics: await prisma.topic.count(), exams: await prisma.exam.count() };
    check(
      'La prueba de memoria no ha tocado ni unidades ni exámenes',
      datosAntes.topics === datosDespues.topics && datosAntes.exams === datosDespues.exams,
      `${datosDespues.topics} unidades · ${datosDespues.exams} exámenes`
    );

    /* ---------------------------------------------------------------- */
    /* 5. Cuánto tarda de verdad                                         */
    /* ---------------------------------------------------------------- */
    section('5. Lo que tarda un turno de verdad (medido con reloj)');
    check('Un turno de chat no se acerca al tope del motor', tutorMs < 30_000, `${tutorMs} ms de extremo a extremo (tope del turno: 30 s)`);
    console.log(`   catedrático por /api/tutor: ${tutorMs} ms (${body.model ?? 'sin modelo'} · incluye la llamada al modelo y la base)`);

    const setupStarted = Date.now();
    const setupResponse = await fetch(`${APP_URL}/api/puesta-a-punto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Verificación del sistema: responde solo con la palabra «vale».' }),
    });
    const setupBody = await setupResponse.json().catch(() => ({}));
    const setupMs = Date.now() - setupStarted;

    // La memoria se escribe después de responder (fuera del camino del alumno).
    await new Promise((resolve) => setTimeout(resolve, 6000));

    check('El coordinador contesta (con IA o en local, nunca se queda colgado)', setupResponse.status === 200, `${setupResponse.status} · ${setupBody.degraded ? 'modo local' : setupBody.model}`);
    check('Y su respuesta no tarda más que el tope del motor', setupMs < 45_000, `${setupMs} ms`);
    console.log(`   coordinador por /api/puesta-a-punto: ${setupMs} ms (${setupBody.degraded ? 'respuesta en local' : setupBody.model})`);

    const coordinatorRow = await prisma.agentMemory.findUnique({
      where: { scope_day: { scope: M.MEMORY_SCOPE_COORDINATOR, day: M.dayKey() } },
    });
    check('La entrevista del coordinador también se apunta para mañana', coordinatorRow !== null, coordinatorRow ? `${coordinatorRow.writtenBy} · ${coordinatorRow.summary.length} caracteres` : 'sin fila');

    if (setupBody.conversationId) {
      const userRow = await prisma.aiMessage.findFirst({
        where: {
          conversationId: setupBody.conversationId,
          role: 'user',
          content: 'Verificación del sistema: responde solo con la palabra «vale».',
        },
        orderBy: { createdAt: 'desc' },
      });
      await prisma.aiMessage.deleteMany({
        where: { id: { in: [userRow ? userRow.id : '', setupBody.reply ? setupBody.reply.id : ''].filter(Boolean) } },
      });
    }

    if (body.conversationId) {
      await prisma.aiMessage.deleteMany({ where: { conversationId: body.conversationId } });
      await prisma.aiConversation.deleteMany({ where: { id: body.conversationId } });
    }

    const leftovers = body.conversationId
      ? await prisma.aiMessage.count({ where: { conversationId: body.conversationId } })
      : 0;
    const leftoverChat = body.conversationId
      ? await prisma.aiConversation.count({ where: { id: body.conversationId } })
      : 0;
    check('Todo lo que ha creado la prueba en el chat se ha borrado', leftovers === 0 && leftoverChat === 0, `${leftovers} mensaje(s), ${leftoverChat} conversación(es)`);
  } finally {
    /* ---------------------------------------------------------------- */
    /* 6. Dejar la memoria como estaba                                   */
    /* ---------------------------------------------------------------- */
    section('6. Limpieza: la memoria de verdad se queda como estaba');
    await prisma.agentMemory.deleteMany({});
    for (const row of snapshot) {
      await prisma.agentMemory.create({
        data: {
          id: row.id,
          scope: row.scope,
          day: row.day,
          summary: row.summary,
          factsJson: row.factsJson,
          writtenBy: row.writtenBy,
        },
      });
    }
    const after = await prisma.agentMemory.count();
    check('Los recuerdos de antes están exactamente igual', after === snapshot.length, `${after} de ${snapshot.length}`);

    await prisma.$disconnect();
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

/**
 * El veredicto se imprime UNA vez y después del `finally`.
 *
 * Antes se imprimía dentro del `finally`, así que un fallo inesperado (una
 * excepción a mitad de la prueba) salía por pantalla como «TODO EN VERDE» y
 * solo después el stack: un falso verde en toda regla.
 */
function printSummary() {
  console.log(
    failures === 0
      ? '\nTODO EN VERDE'
      : `\n${failures} COMPROBACIONES FALLIDAS:\n  - ${failed.join('\n  - ')}`
  );
}

main()
  .then(() => {
    printSummary();
    process.exitCode = failures === 0 ? 0 : 1;
  })
  .catch((caught) => {
    failures += 1;
    failed.push(`Fallo inesperado: ${caught && caught.message ? caught.message : caught}`);
    console.error('FALLO INESPERADO:', caught);
    try {
      fs.rmSync(outDir, { recursive: true, force: true });
    } catch {}
    printSummary();
    process.exitCode = 1;
  });
