/**
 * Volcado del plan semanal agrupado por día, con recuento por asignatura.
 * Útil para comprobar por qué el planificador prioriza unos temas y no otros
 * (exámenes próximos, entregas de Moodle, domino bajo, errores pendientes).
 *
 * Uso: node scripts/dump-week-plan.js   (o npm run plan:dump)
 */
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);

  const blocks = await prisma.studyBlock.findMany({
    where: { date: { gte: start } },
    include: { topic: { include: { subject: true } } },
    orderBy: [{ date: 'asc' }, { orderIndex: 'asc' }],
  });

  const byDay = new Map();
  for (const block of blocks) {
    // Fecha local: toISOString() restaba un día a los bloques de medianoche.
    const date = new Date(block.date);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
      date.getDate()
    ).padStart(2, '0')}`;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(block);
  }

  const counts = {};
  blocks.slice(0, 8).forEach((b) => {
    const name = b.topic.subject.name;
    counts[name] = (counts[name] || 0) + 1;
  });

  console.log(`Total bloques futuros: ${blocks.length}`);
  console.log('Recuento por asignatura en los 8 primeros bloques:');
  Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([name, count]) => console.log(`  ${count}x ${name}`));
  console.log('');

  for (const [day, dayBlocks] of byDay) {
    const weekday = new Date(day).toLocaleDateString('es-ES', { weekday: 'long' });
    console.log(`${day} (${weekday}):`);
    dayBlocks.forEach((b) => {
      console.log(`  ${b.orderIndex}. [${b.topic.subject.name}] ${b.topic.title} (${b.technique})`);
    });
  }
}

main()
  .catch((error) => {
    console.error('FALLO:', error.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
