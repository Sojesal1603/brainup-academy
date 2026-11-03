/**
 * Verificación end-to-end del Examinador PAU por su interfaz real (HTTP):
 * inicio de simulacro (IA con respaldo local), cronómetro, corrección por
 * rúbrica, informe persistido, historial e idempotencia del reenvío.
 * Limpia la sesión de prueba al final.
 *
 * Requisitos: servidor de desarrollo en http://localhost:3000 y claves de IA en
 * .env (sin claves comprueba la degradación a plantillas locales).
 *
 * Uso: node scripts/verify-examinador.js   (o npm run verify:examinador)
 */
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const BASE = 'http://localhost:3000';

/**
 * Lo que esta prueba toca en tus datos, para devolverlo tal y como estaba.
 *
 * Corregir un simulacro **mide de verdad**: marca las unidades que han salido
 * como `simulacro` (medidas) y les ajusta el dominio. Eso es lo correcto cuando
 * lo hace el alumno, pero una prueba que se olvida de deshacerlo deja en su base
 * unidades «medidas» con un nivel que nadie ha medido, y eso envenena el plan y
 * las estadísticas (la página de estadísticas llegaba a decir «sin datos» con
 * cuatro unidades medidas: la medida era falsa). Aquí se apunta el estado previo
 * y se devuelve en el `finally`, aunque la prueba falle a medias.
 */
let touchedTopics = [];
/** Sesión de simulacro creada por la prueba (se borra siempre, también al fallar). */
let createdSessionId = null;

async function undoTestEffects() {
  for (const topic of touchedTopics) {
    await prisma.topic
      .update({
        where: { id: topic.id },
        data: { masteryLevel: topic.masteryLevel, masterySource: topic.masterySource },
      })
      .catch(() => {});
  }
  if (touchedTopics.length > 0) {
    console.log(`Unidades devueltas a su estado previo: ${touchedTopics.length}`);
  }
  touchedTopics = [];

  if (createdSessionId) {
    await prisma.pauExamSession.deleteMany({ where: { id: createdSessionId } }).catch(() => {});
    createdSessionId = null;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GET con reintento: en dev, la primera visita a una ruta recién compilada
 * puede fallar mientras webpack escribe los chunks. Se declara el primer
 * estado y el definitivo para no ocultar nada.
 */
async function getWithRetry(url) {
  const first = await fetch(url);
  const firstBody = await first.text();
  if (first.status === 200) {
    return { status: first.status, firstStatus: first.status, html: firstBody };
  }
  await sleep(2500);
  const retry = await fetch(url);
  const retryBody = await retry.text();
  return { status: retry.status, firstStatus: first.status, html: retryBody };
}

async function main() {
  // 0. Elegir asignatura con más temas (mejor para generar 4 bloques)
  const subjects = await prisma.subject.findMany({ include: { topics: true } });
  const subject = subjects.sort((a, b) => b.topics.length - a.topics.length)[0];
  if (!subject) throw new Error('No hay asignaturas en la BD');
  console.log(`Asignatura elegida: ${subject.name} (${subject.topics.length} temas)`);

  // 1. Página índice del examinador
  const indexRes = await getWithRetry(`${BASE}/examinador`);
  console.log(
    `GET /examinador -> ${indexRes.status} (1er intento: ${indexRes.firstStatus}) | título: ${indexRes.html.includes('Examinador PAU')} | botones: ${(
      indexRes.html.match(/Iniciar Simulacro Cronometrado/g) || []
    ).length}`
  );
  await sleep(1500);

  // 2. Iniciar simulacro (IA con respaldo local)
  const startRes = await fetch(`${BASE}/api/examinador/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subjectId: subject.id }),
  });
  const startData = await startRes.json();
  console.log(`POST /api/examinador/start -> ${startRes.status} | fuente: ${startData.source} | modelo: ${startData.model || 'n/a'}`);
  if (!startData.sessionId) throw new Error(`Sin sessionId: ${JSON.stringify(startData)}`);
  const sessionId = startData.sessionId;

  createdSessionId = sessionId;

  const session = await prisma.pauExamSession.findUnique({ where: { id: sessionId } });
  const blocks = JSON.parse(session.questionsJson).blocks;
  console.log(`Bloques guardados: ${blocks.length}`);

  // Estado previo de las unidades que la corrección va a medir.
  touchedTopics = await prisma.topic.findMany({
    where: { subjectId: subject.id, title: { in: blocks.map((block) => block.topicTitle) } },
    select: { id: true, masteryLevel: true, masterySource: true },
  });
  blocks.forEach((b, i) => console.log(`  ${i + 1}. [${b.topicTitle}] ${b.prompt.slice(0, 90)}...`));

  // 3. Página de la sesión activa (debe mostrar el cronómetro)
  await sleep(1500);
  const liveRes = await getWithRetry(`${BASE}/examinador/${sessionId}`);
  console.log(
    `GET /examinador/${sessionId.slice(0, 8)}… -> ${liveRes.status} (1er intento: ${liveRes.firstStatus}) | cronómetro: ${/\d\d:\d\d/.test(liveRes.html)} | aviso borrador: ${liveRes.html.includes('no pierdes lo escrito')} | bloques: ${(liveRes.html.match(/Escribe tu resolución completa/g) || []).length}`
  );
  await sleep(1500);

  // 4. Corrección con IA (respuestas honestas y breves)
  const answers = blocks.map(
    (b, i) =>
      `Bloque ${i + 1} sobre ${b.topicTitle}: planteo el problema, desarrollo los pasos y llego a un resultado con unidades. (respuesta de prueba)`
  );
  const submitRes = await fetch(`${BASE}/api/examinador/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, answers, elapsedMinutes: 47 }),
  });
  const submitData = await submitRes.json();
  console.log(`POST /api/examinador/submit -> ${submitRes.status} | ok: ${submitData.ok} | modo: ${submitData.mode || submitData.grade?.mode || 'n/a'}`);
  if (submitData.grade) {
    console.log(
      `  Nota: ${submitData.grade.total}/10 | modelo: ${submitData.grade.model} | débiles: ${submitData.grade.weakTopicTitles.join(', ') || 'ninguno'}`
    );
    console.log(`  Feedback global: ${submitData.grade.globalFeedback.replace(/\n/g, ' | ').slice(0, 160)}`);
  } else {
    console.log(`  Mensaje: ${submitData.message}`);

    // 4b. Sin IA: autoevaluación guiada
    const selfRes = await fetch(`${BASE}/api/examinador/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        answers,
        elapsedMinutes: 47,
        selfScores: [2.5, 2, 1.5, 2.25],
      }),
    });
    const selfData = await selfRes.json();
    console.log(
      `POST (autoevaluación) -> ${selfRes.status} | ok: ${selfData.ok} | modo: ${selfData.grade?.mode} | nota: ${selfData.grade?.total}/10`
    );
  }

  // 5. Informe persistido
  const done = await prisma.pauExamSession.findUnique({ where: { id: sessionId } });
  console.log(
    `Sesión en BD: completada=${done.isCompleted} | nota=${done.finalScore} | min=${done.elapsedMinutes} | respuestas guardadas=${JSON.parse(done.answersJson || '[]').length}`
  );

  // 6. Página del informe
  await sleep(1500);
  const reportRes = await getWithRetry(`${BASE}/examinador/${sessionId}`);
  console.log(
    `GET informe -> ${reportRes.status} (1er intento: ${reportRes.firstStatus}) | "Simulacro corregido": ${reportRes.html.includes('Simulacro corregido')} | informe por bloque: ${reportRes.html.includes('Comentario del corrector')} | KaTeX: ${reportRes.html.includes('katex')}`
  );

  // 7. Aparece en el historial del índice
  const index2Res = await getWithRetry(`${BASE}/examinador`);
  console.log(`Historial en /examinador: ${index2Res.html.includes(sessionId) ? 'SÍ' : 'NO'}`);

  // 8. Idempotencia: reenviar el mismo simulacro no re-corrige
  const again = await fetch(`${BASE}/api/examinador/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, answers: [''], elapsedMinutes: 1 }),
  });
  const againData = await again.json();
  console.log(`Reenvío -> ${again.status} | misma nota: ${againData.grade?.total === done.finalScore}`);

  // 9. Limpieza: borrar la sesión de prueba para no ensuciar el historial y
  // devolver las unidades a su estado previo (nada de niveles «medidos» falsos).
  await prisma.pauExamSession.delete({ where: { id: sessionId } });
  createdSessionId = null;
  // La medida que ha hecho la corrección se deshace aquí: es de la prueba, no
  // del alumno.
  const antesDeLimpiar = touchedTopics.length;
  await undoTestEffects();
  const remaining = await prisma.pauExamSession.count();
  console.log(
    `Sesión de prueba eliminada. Sesiones restantes: ${remaining} · unidades restauradas: ${antesDeLimpiar}`
  );
}

main()
  .catch((error) => {
    console.error('FALLO:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Red de seguridad: si la prueba ha muerto a medias, no deja ni la sesión ni
    // unidades «medidas» que nadie ha medido.
    await undoTestEffects();
    await prisma.$disconnect();
  });
