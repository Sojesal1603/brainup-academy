/**
 * Verificación de marca blanca del chat del catedrático.
 *
 * Comprueba dos cosas distintas:
 *
 *   1. **Comportamiento**: los errores públicos, las frases de estado del SSE y
 *      la respuesta local no nombran proveedores ni modelos técnicos; el marco
 *      SSE es válido; la clave idempotente es estable y no revela nada.
 *   2. **Superficies**: la ruta del tutor, el endpoint de reanudación y los
 *      componentes del chat no vuelven a pintar ni devolver identidad de
 *      proveedor/modelo, y el flujo de streaming conserva persistencia previa,
 *      `clientKey` y reintento.
 *
 * No necesita base de datos, red ni sesión. Uso: `npm run verify:marca`.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { compilaTs, projectRoot } = require('./lib/compilaTs');
const { loadEnv } = require('./lib/loadEnv');

loadEnv();

const outDir = compilaTs(
  ['tutorPublicError', 'tutorStream', 'tutorFallback', 'tutorTurnKey'],
  '.tmp-verify-marca'
);
const publicError = require(path.join(outDir, 'tutorPublicError.js'));
const stream = require(path.join(outDir, 'tutorStream.js'));
const fallback = require(path.join(outDir, 'tutorFallback.js'));
const turnKey = require(path.join(outDir, 'tutorTurnKey.js'));
const engine = require(path.join(outDir, 'aiEngine.js'));

/**
 * Nombres de proveedor y fragmentos de modelos técnicos que no pueden llegar
 * al alumno. Se buscan como palabras sueltas para no marcar «programa» ni
 * «modelo» genérico.
 */
const FORBIDDEN = [
  /\bgemini\b/i,
  /\bgroq\b/i,
  /\bopenrouter\b/i,
  /\bnvidia\b/i,
  /\bollama\b/i,
  /\bgpt-?oss\b/i,
  /\bllama\b/i,
  /\bqwen\b/i,
  /\bdeepseek\b/i,
  /\bclaude\b/i,
  /\bflash-lite\b/i,
  /\b\d(?:\.\d)?-flash\b/i,
];

function leaks(text) {
  return FORBIDDEN.some((pattern) => pattern.test(String(text)));
}

/** Quita comentarios para auditar solo lo que se pinta o se devuelve. */
function stripComments(source) {
  let inBlock = false;
  return source
    .split('\n')
    .map((line) => {
      let text = line;
      if (inBlock) {
        const end = text.indexOf('*/');
        if (end < 0) return '';
        text = text.slice(end + 2);
        inBlock = false;
      }
      const start = text.indexOf('/*');
      if (start >= 0) {
        const end = text.indexOf('*/', start + 2);
        if (end < 0) {
          inBlock = true;
          text = text.slice(0, start);
        } else {
          text = `${text.slice(0, start)}${text.slice(end + 2)}`;
        }
      }
      if (text.trim().startsWith('//')) return '';
      return text;
    })
    .join('\n');
}

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

let checks = 0;
function ok(name, fn) {
  fn();
  checks += 1;
  console.log(`  ✓ ${name}`);
}

(async () => {
  console.log('\n  Marca blanca del chat\n');

  console.log('  1) Errores públicos neutros');
  const statuses = [400, 404, 413, 429, 500, 502, 503];
  for (const status of statuses) {
    ok(`un ${status} se cuenta sin nombre de proveedor ni modelo`, () => {
      const mapped = publicError.publicTutorError(
        new engine.TutorError(
          `Gemini/Groq fallaron con gemini-3.5-flash-lite y gpt-oss-120b`,
          status,
          'openrouter nvidia ollama'
        )
      );
      assert.equal(mapped.status, status);
      assert.ok(mapped.message.length > 20, 'el mensaje debe orientar al alumno');
      assert.ok(!leaks(mapped.message), `filtra identidad: ${mapped.message}`);
    });
  }

  ok('un fallo desconocido tampoco reenvía el mensaje técnico', () => {
    const mapped = publicError.publicTutorError(
      new Error('ECONNRESET contra api.groq.com con llama-3.3-70b')
    );
    assert.equal(mapped.status, 500);
    assert.equal(mapped.retryable, true);
    assert.ok(!leaks(mapped.message));
  });

  console.log('\n  2) Contrato SSE y frases de estado');
  ok('los eventos del chat son los seis del contrato', () => {
    assert.deepEqual(
      Array.from(stream.TUTOR_STREAM_EVENTS).sort(),
      ['delta', 'done', 'error', 'heartbeat', 'open', 'status'].sort()
    );
  });

  ok('las frases de estado no nombran proveedores ni modelos', () => {
    assert.ok(stream.TUTOR_STREAM_STATUS_LINES.length >= 3);
    for (const line of stream.TUTOR_STREAM_STATUS_LINES) {
      assert.ok(line.trim().length > 0);
      assert.ok(!leaks(line), `filtra identidad: ${line}`);
    }
  });

  ok('un evento SSE es válido, con una sola línea de datos JSON', () => {
    const frame = stream.tutorSseFrame('delta', { text: 'hola' });
    assert.match(frame, /^event: delta\ndata: /);
    assert.ok(frame.endsWith('\n\n'));
    const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
    assert.deepEqual(JSON.parse(dataLine.slice(6)), { text: 'hola' });
    assert.ok(!frame.includes('undefined'));
  });

  console.log('\n  3) Respaldo local y clave idempotente');
  ok('el respaldo local habla de la academia, no del proveedor', () => {
    const text = fallback.buildLocalTutorReply({
      agentName: 'Ada',
      subjectName: 'Física',
      studentName: 'Ana',
      message: 'Ayúdame con la derivada',
      weakTopic: null,
      nextExam: null,
      unmeasuredCount: 0,
      pendingErrors: 0,
      courseUnit: null,
      noteTitles: [],
    });
    assert.ok(!leaks(text), `filtra identidad: ${text.slice(0, 160)}`);
    assert.ok(!text.includes('⚠️'), 'sin avisos bruscos');
    assert.match(text, /servicio de IA/i);
  });

  ok('la misma clientKey produce el mismo id de turno, y no lo revela', () => {
    const first = turnKey.turnRowId('alumno-a', 'clave-1', 'user');
    const again = turnKey.turnRowId('alumno-a', 'clave-1', 'user');
    const otherUser = turnKey.turnRowId('alumno-b', 'clave-1', 'user');
    const reply = turnKey.turnRowId('alumno-a', 'clave-1', 'reply');

    assert.equal(first, again);
    assert.notEqual(first, otherUser);
    assert.notEqual(first, reply);
    assert.ok(turnKey.isTurnRowId(first));
    assert.ok(!first.includes('clave-1'));
    assert.ok(!first.includes('alumno-a'));
  });

  console.log('\n  4) Superficies públicas del chat');
  const route = stripComments(read('src/app/api/tutor/route.ts'));
  const resume = stripComments(
    read('src/app/api/tutor/turns/[turnId]/stream/route.ts')
  );
  const chat = stripComments(read('src/components/brainup/TutorChat.tsx'));
  const panel = stripComments(read('src/components/brainup/NoteSplitPanel.tsx'));
  const page = stripComments(read('src/app/brainup/[agentId]/page.tsx'));
  const notesRoute = stripComments(read('src/app/api/tutor/notes/route.ts'));
  const toolsRoute = stripComments(read('src/app/api/tutor/tools/route.ts'));

  ok('la ruta del tutor no devuelve model/provider ni reenvía error.message', () => {
    assert.ok(!/model:\s*reply\./.test(route), 'model en la respuesta');
    assert.ok(!/provider:\s*reply\./.test(route), 'provider en la respuesta');
    assert.ok(!/error:\s*error\.message/.test(route), 'mensaje técnico reenviado');
    assert.ok(route.includes('publicTutorError'));
  });

  ok('el turno se persiste ANTES de llamar al motor', () => {
    const userInsert = route.indexOf('let userMessageRow');
    const aiCall = route.indexOf('await runAiText(');
    assert.ok(userInsert > 0, 'no se encuentra la persistencia del mensaje');
    assert.ok(aiCall > 0, 'no se encuentra la llamada al motor');
    assert.ok(
      userInsert < aiCall,
      'el mensaje del alumno debe guardarse antes de la inferencia'
    );
    // El turno ya guardado se excluye del historial para no repetir la pregunta.
    assert.ok(route.includes('id: { not: turnUserRowId }'));
  });

  ok('el POST es idempotente y reanudable', () => {
    assert.ok(route.includes('clientKey'));
    assert.ok(route.includes('turnRowId'));
    assert.ok(route.includes('isUniqueViolation'));
    assert.ok(route.includes('replayed: true'));
    assert.ok(resume.includes('turn_pending'));
    assert.ok(resume.includes('aiMessage.findFirst'));
  });

  ok('el stream tiene cabeceras SSE, latidos y estados', () => {
    assert.ok(route.includes("'Content-Type': 'text/event-stream; charset=utf-8'"));
    assert.ok(route.includes("'X-Accel-Buffering': 'no'"));
    assert.ok(/send\('heartbeat'/.test(route));
    assert.ok(/send\('status'/.test(route));
    assert.ok(/send\('delta'/.test(route));
    assert.ok(/send\('done'/.test(route));
  });

  ok('los endpoints asociados del chat no devuelven identidad técnica', () => {
    for (const [label, source] of [
      ['notes', notesRoute],
      ['tools', toolsRoute],
    ]) {
      // Solo se auditan las respuestas públicas. El borrador interno conserva
      // la identidad para los logs del servidor, que el alumno no ve.
      assert.ok(!source.includes('model: draft.model'), `${label}: model de borrador en respuesta`);
      assert.ok(!source.includes('provider: draft.provider'), `${label}: provider de borrador en respuesta`);
      assert.ok(!source.includes('model: result.model'), `${label}: model de resultado`);
      assert.ok(!source.includes('provider: result.provider'), `${label}: provider de resultado`);
      assert.ok(!source.includes('error: error.message'), `${label}: error técnico reenviado`);
      assert.ok(source.includes('publicTutorError'), `${label}: sin error público neutro`);
    }
  });

  ok('los componentes no pintan proveedor ni modelo técnico', () => {
    for (const [file, source] of [
      ['TutorChat.tsx', chat],
      ['NoteSplitPanel.tsx', panel],
      ['page.tsx', page],
    ]) {
      assert.ok(!leaks(source), `${file} filtra identidad de proveedor/modelo`);
    }
    assert.ok(!chat.includes('activeModel'), 'sigue el estado del modelo');
    assert.ok(!chat.includes('providerName'), 'sigue el rótulo del proveedor');
    assert.ok(!chat.includes('data.model'), 'sigue leyendo el modelo del servidor');
    assert.ok(!chat.includes('data.provider'), 'sigue leyendo el proveedor del servidor');
  });

  ok('el cliente pide SSE, manda clientKey y reintenta con la misma clave', () => {
    assert.ok(chat.includes("Accept: 'text/event-stream'"));
    assert.ok(chat.includes('clientKey'));
    assert.ok(chat.includes('readTutorEventStream'));
    assert.ok(chat.includes('failedTurn.clientKey'));
    assert.ok(!chat.includes("signal: timeoutSignal(STREAM_IDLE_MS)"));
  });

  ok('la página no anuncia el motor en la cabecera', () => {
    assert.ok(!page.includes('getConfiguredModelLabel'));
    assert.ok(!page.includes('engineLabel'));
    assert.ok(page.includes('Versión ${String.fromCharCode'));
  });

  ok('el script está registrado en package.json', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.equal(pkg.scripts['verify:marca'], 'node scripts/verify-marca.js');
  });

  console.log(`\n  ${checks} comprobaciones en verde. Marca blanca intacta.\n`);
})().catch((error) => {
  console.error('\n  ✗ La verificación de marca ha fallado:\n');
  console.error(error);
  process.exitCode = 1;
});
