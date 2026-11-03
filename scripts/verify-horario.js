/**
 * Comprueba que el plan semanal respeta tu horario de clases importado.
 *
 * Regla del planificador: los bloques de un día se asignan, siempre que se
 * pueda, a asignaturas que tienen clase el **día lectivo siguiente** (estudiar
 * la tarde antes de la clase). Este script verifica esa invariante sobre los
 * bloques reales de la base y avisa de las excepciones.
 *
 * Uso: node scripts/verify-horario.js   (o npm run verify:horario)
 */
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const DAY_NAMES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

/** Fecha local en formato AAAA-MM-DD (toISOString desplazaría el día). */
function localDate(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function nextSchoolDayIndex(date) {
  const day = date.getDay();
  for (let offset = 1; offset <= 7; offset += 1) {
    const candidate = (day + offset) % 7;
    if (candidate >= 1 && candidate <= 5) return candidate;
  }
  return 1;
}

async function main() {
  const periods = await prisma.classPeriod.findMany({
    include: { subject: { select: { name: true } } },
  });

  if (periods.length === 0) {
    throw new Error('No hay franjas lectivas: importa tu horario antes de verificar.');
  }

  const subjectsByDay = new Map();
  for (const period of periods) {
    if (!subjectsByDay.has(period.dayOfWeek)) subjectsByDay.set(period.dayOfWeek, new Set());
    subjectsByDay.get(period.dayOfWeek).add(period.subject.name);
  }

  console.log('Horario cargado:');
  for (const day of [1, 2, 3, 4, 5]) {
    const list = [...(subjectsByDay.get(day) ?? [])].sort().join(', ');
    console.log(`  ${DAY_NAMES[day].padEnd(10)} ${list}`);
  }

  const start = new Date();
  start.setHours(0, 0, 0, 0);

  const blocks = await prisma.studyBlock.findMany({
    where: { date: { gte: start } },
    include: { topic: { include: { subject: { select: { name: true, id: true } } } } },
    orderBy: [{ date: 'asc' }, { orderIndex: 'asc' }],
  });

  if (blocks.length === 0) {
    // El temario lo aporta el alumno: sin unidades no hay plan que comprobar.
    // Si hay temario y aun así no hay bloques, eso sí es un fallo real.
    const topics = await prisma.topic.count();
    if (topics === 0) {
      console.log(
        '\nSin temario cargado no hay plan que comprobar. Pega tu índice en /temario → «Cargar tu temario» y el plan se rehace solo.'
      );
      return;
    }
    throw new Error('No hay bloques futuros: recalcula el plan desde el Cuartel.');
  }

  const byDay = new Map();
  for (const block of blocks) {
    const key = new Date(block.date);
    key.setHours(0, 0, 0, 0);
    if (!byDay.has(key.getTime())) byDay.set(key.getTime(), []);
    byDay.get(key.getTime()).push(block);
  }

  let checked = 0;
  let violations = 0;

  console.log('\nBloques por día (día de estudio → clase del día siguiente):');
  for (const [timestamp, dayBlocks] of [...byDay.entries()].sort((a, b) => a[0] - b[0])) {
    const date = new Date(timestamp);
    const nextDay = nextSchoolDayIndex(date);
    const expected = subjectsByDay.get(nextDay) ?? new Set();

    const counts = new Map();
    let dayViolations = 0;

    for (const block of dayBlocks) {
      const name = block.topic.subject.name;
      counts.set(name, (counts.get(name) ?? 0) + 1);
      checked += 1;
      if (expected.has(name)) continue;
      dayViolations += 1;
      violations += 1;
    }

    const detail = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `${count}× ${name}`)
      .join(' · ');

    console.log(
      `  ${DAY_NAMES[date.getDay()]} ${localDate(date)} ` +
        `(prepara ${DAY_NAMES[nextDay]}): ${detail} ` +
        (dayViolations === 0 ? '✓' : `⚠ ${dayViolations} fuera de horario`)
    );
  }

  console.log(
    `\nBloques comprobados: ${checked} · fuera del horario del día siguiente: ${violations}`
  );
  if (violations > 0) {
    console.log(
      'Nota: un bloque puede caer fuera de horario si no quedan temas disponibles en las asignaturas de ese día.'
    );
    process.exitCode = 1;
  } else {
    console.log('El plan respeta tu horario real en todos los bloques.');
  }
}

main()
  .catch((error) => {
    console.error('FALLO:', error.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
