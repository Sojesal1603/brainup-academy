/**
 * Verificación end-to-end del Tutor IA por su interfaz real (HTTP):
 * dos turnos de conversación, etapa socrática, memoria entre turnos y
 * persistencia local. Muestra el modelo que eligió el motor automático.
 *
 * Requisitos: servidor de desarrollo en http://localhost:3000 y GEMINI_API_KEY
 * (o GROQ_API_KEY) en .env. Hace llamadas reales a la API y guarda la
 * conversación en la base local, como si chatearas tú.
 *
 * Uso: node scripts/verify-tutor.js   (o npm run verify:tutor)
 */
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const BASE = 'http://localhost:3000';

async function main() {
  // Limpieza segura: solo conversaciones vacías creadas por intentos fallidos.
  const junk = await p.aiConversation.deleteMany({ where: { messages: { none: {} } } });
  console.log('Conversaciones vacías limpiadas:', junk.count);

  const agent = await p.aiAgent.findFirst({
    orderBy: { subject: { order: 'asc' } },
    include: { subject: true },
  });
  console.log('Agente de prueba:', agent.name);

  const r1 = await fetch(`${BASE}/api/tutor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentId: agent.id,
      // Conversación propia de la verificación: no se escribe (ni se borra)
      // en el hilo real del alumno.
      fresh: true,
      message:
        'No entiendo cómo resolver esta ecuación trigonométrica: 2sin(x) = 1. Ayúdame a empezar sin darme la solución; tengo examen el lunes.',
    }),
  });
  const j1 = await r1.json();
  console.log('\n=== Turno 1 ===');
  console.log('HTTP:', r1.status, '| modelo:', j1.model || '-');
  if (j1.error) {
    console.log('ERROR:', j1.error);
    return;
  }
  console.log('etapa:', j1.reply.stage);
  console.log('conversación:', j1.conversationId);
  console.log('respuesta:', j1.reply.content.slice(0, 400));

  const r2 = await fetch(`${BASE}/api/tutor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentId: agent.id,
      conversationId: j1.conversationId,
      message:
        'Vale, he pensado que hay que despejar sin(x) = 1/2. ¿Cómo sigo para sacar los ángulos?',
    }),
  });
  const j2 = await r2.json();
  console.log('\n=== Turno 2 (memoria de conversación) ===');
  console.log('HTTP:', r2.status, '| modelo:', j2.model || '-');
  if (j2.error) {
    console.log('ERROR:', j2.error);
    return;
  }
  console.log('etapa:', j2.reply.stage);
  console.log('respuesta:', j2.reply.content.slice(0, 400));

  const convo = await p.aiConversation.findUnique({
    where: { id: j1.conversationId },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  });
  console.log('\n=== Persistencia ===');
  console.log(
    'conversaciones:',
    await p.aiConversation.count(),
    '| mensajes:',
    await p.aiMessage.count()
  );
  for (const m of convo.messages) {
    const stepCount = m.rawStepsJson ? JSON.parse(m.rawStepsJson).length : 0;
    console.log(
      `- ${m.role.padEnd(9)} etapa=${String(m.stepStage || '-').padEnd(12)} pasos=${stepCount} | "${m.content.slice(0, 70)}..."`
    );
  }
}

main()
  .catch((e) => console.error('FALLO:', e))
  .finally(() => p.$disconnect());
