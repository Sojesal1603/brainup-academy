/**
 * Importa tu horario de clases real (cuadrícula HTML Lunes-Viernes) a la base
 * local de BrainUp, para que el planificador priorice las asignaturas que
 * tienes al día siguiente y la pantalla /horario muestre tu cuadrícula real.
 *
 * Uso:
 *   node scripts/import-horario.js "C:\ruta\a\horario_clases.html"
 *   npm run horario:import -- "C:\ruta\a\horario_clases.html"
 *
 * Qué hace:
 *   1. Lee la tabla del HTML: cabecera de días y celdas con «Nª hora» + nombre.
 *   2. Mapea cada nombre a la asignatura de la base (y crea las que falten,
 *      como Religión o Educación Física, con peso PAU 0 y sin fase general).
 *   3. Sustituye las franjas lectivas por tu horario real.
 *   4. Muestra un resumen: carga lectiva semanal y el reparto por días.
 *
 * Aulas: el HTML no las trae, así que quedan vacías. Si las quieres, añade
 * `data-aula="Aula 104"` a la celda del HTML o rellena ROOMS aquí abajo.
 *
 * Las horas de cada franja vienen de SLOT_TIMES (abajo): es lo único que hay
 * que tocar si tu instituto cambia los tramos o el recreo.
 */
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

/**
 * Tramos horarios reales: 6 clases de 60 min con el recreo (11:15–11:45)
 * después de la tercera, de 08:15 a 14:45.
 */
const SLOT_TIMES = {
  1: { startTime: '08:15', endTime: '09:15' },
  2: { startTime: '09:15', endTime: '10:15' },
  3: { startTime: '10:15', endTime: '11:15' },
  4: { startTime: '11:45', endTime: '12:45' },
  5: { startTime: '12:45', endTime: '13:45' },
  6: { startTime: '13:45', endTime: '14:45' },
};

const DAY_NAMES = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes'];

/** Aulas por asignatura (opcional). El atributo `data-aula` del HTML manda. */
const ROOMS = {};

/**
 * Nombre en el HTML → asignatura de la base.
 * `create` solo se usa si la asignatura todavía no existe.
 */
const SUBJECT_MAP = {
  matematicas: { name: 'Matemáticas I' },
  'fisica y quimica': { name: 'Física y Química' },
  lengua: { name: 'Lengua Castellana y Literatura I' },
  ingles: { name: 'Inglés I' },
  'dibujo tecnico': { name: 'Dibujo Técnico I' },
  tecnologia: { name: 'Tecnología e Ingeniería I' },
  filosofia: { name: 'Filosofía' },
  religion: {
    name: 'Religión',
    create: { color: '#94a3b8', pauWeight: 0, isPhaseGeneral: false, order: 8 },
  },
  'educacion fisica': {
    name: 'Educación Física',
    create: { color: '#22c55e', pauWeight: 0, isPhaseGeneral: false, order: 9 },
  },
};

/** Quita acentos y signos para comparar nombres de asignatura sin sorpresas. */
function normalize(value) {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveSubject(htmlName) {
  const key = normalize(htmlName);
  if (SUBJECT_MAP[key]) return SUBJECT_MAP[key];

  // Coincidencia por prefijo (p. ej. «Matemáticas» → «Matemáticas I»).
  for (const [alias, target] of Object.entries(SUBJECT_MAP)) {
    if (key.startsWith(alias) || alias.startsWith(key)) return target;
  }
  return null;
}

/** Extrae la cuadrícula: { lunes: [{ period, subject }...], ... } */
function parseTimetable(html) {
  const theadMatch = html.match(/<thead>([\s\S]*?)<\/thead>/i);
  if (!theadMatch) throw new Error('No encuentro la cabecera (<thead>) del horario.');

  const days = [...theadMatch[1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((match) =>
    match[1].replace(/<[^>]+>/g, '').trim()
  );
  if (days.length === 0) throw new Error('La cabecera del horario no tiene días.');

  const tbodyMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/i);
  if (!tbodyMatch) throw new Error('No encuentro las filas (<tbody>) del horario.');

  const rows = [...tbodyMatch[1].matchAll(/<tr>([\s\S]*?)<\/tr>/gi)];
  if (rows.length === 0) throw new Error('El horario no tiene filas.');

  const grid = days.map((day) => ({ day, classes: [] }));
  const unknown = new Set();

  rows.forEach((row, rowIndex) => {
    const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => match[1]);

    cells.forEach((cell, dayIndex) => {
      const hourLabel = (cell.match(/class="hora"[^>]*>([^<]*)</i) || [])[1] || '';
      const subjectLabel = (cell.match(/class="nomb"[^>]*>([^<]*)</i) || [])[1] || '';

      const subject = subjectLabel.trim();
      if (!subject) return; // celda vacía: esa hora no hay clase

      const parsedPeriod = Number((hourLabel.match(/(\d+)/) || [])[1]);
      const period = parsedPeriod || rowIndex + 1;
      const classroom = (cell.match(/data-aula="([^"]*)"/i) || [])[1] || null;

      const mapped = resolveSubject(subject);
      if (!mapped) unknown.add(subject);

      grid[dayIndex].classes.push({
        period,
        subject,
        mappedName: mapped ? mapped.name : null,
        classroom: classroom || ROOMS[subject] || null,
      });
    });
  });

  return { days, grid, unknown };
}

async function main() {
  const sourcePath = process.argv[2];
  if (!sourcePath) {
    console.error('Uso: node scripts/import-horario.js "<ruta al horario.html>"');
    process.exit(1);
  }
  if (!fs.existsSync(sourcePath)) {
    console.error(`No encuentro el archivo: ${sourcePath}`);
    process.exit(1);
  }

  const html = fs.readFileSync(sourcePath, 'utf8');
  const { days, grid, unknown } = parseTimetable(html);

  if (unknown.size > 0) {
    console.error(
      `Hay asignaturas en el HTML que no sé mapear: ${[...unknown].join(', ')}. ` +
        'Añádelas a SUBJECT_MAP en scripts/import-horario.js.'
    );
    process.exit(1);
  }

  const totalCells = grid.reduce((acc, day) => acc + day.classes.length, 0);
  console.log(`Leídas ${totalCells} clases en ${days.length} días: ${days.join(', ')}`);

  // 1. Asignaturas: se reutilizan las que ya existen y se crean las que falten.
  const subjects = await prisma.subject.findMany();
  const byName = new Map(subjects.map((s) => [s.name, s]));
  const created = [];

  for (const day of grid) {
    for (const item of day.classes) {
      const target = Object.values(SUBJECT_MAP).find((entry) => entry.name === item.mappedName);
      if (!target || byName.has(target.name)) continue;
      const subject = await prisma.subject.create({
        data: {
          name: target.name,
          color: target.create?.color ?? '#64748b',
          pauWeight: target.create?.pauWeight ?? 0,
          isPhaseGeneral: target.create?.isPhaseGeneral ?? false,
          order: target.create?.order ?? subjects.length + 1,
        },
      });
      byName.set(subject.name, subject);
      created.push(subject.name);
    }
  }

  // 2. Sustitución del horario completo (es un espejo del instituto, no se mezcla).
  const removed = await prisma.classPeriod.deleteMany();

  let inserted = 0;
  const perSubject = new Map();

  for (const day of grid) {
    const dayNumber = DAY_NAMES.indexOf(day.day) + 1;
    if (dayNumber < 1) {
      console.warn(`Día no lectivo reconocido en el HTML: ${day.day} (se omite)`);
      continue;
    }

    for (const item of day.classes) {
      const slot = SLOT_TIMES[item.period];
      if (!slot) {
        console.warn(`Sin tramo horario para la ${item.period}ª hora (${item.subject}): se omite.`);
        continue;
      }

      const subject = byName.get(item.mappedName);
      if (!subject) throw new Error(`Asignatura no encontrada en la base: ${item.mappedName}`);

      await prisma.classPeriod.create({
        data: {
          dayOfWeek: dayNumber,
          period: item.period,
          startTime: slot.startTime,
          endTime: slot.endTime,
          subjectId: subject.id,
          classroom: item.classroom ?? null,
        },
      });

      inserted += 1;
      const entry = perSubject.get(subject.name) ?? { count: 0, minutes: 0 };
      entry.count += 1;
      entry.minutes += minutesBetween(slot.startTime, slot.endTime);
      perSubject.set(subject.name, entry);
    }
  }

  console.log(
    `Franjas anteriores: ${removed.count} · franjas importadas: ${inserted}` +
      (created.length > 0 ? ` · asignaturas nuevas: ${created.join(', ')}` : '')
  );

  console.log('\nCarga lectiva semanal:');
  const ranking = [...perSubject.entries()].sort((a, b) => b[1].minutes - a[1].minutes);
  for (const [name, data] of ranking) {
    console.log(`  ${String(data.count).padStart(2)} clases · ${(data.minutes / 60).toFixed(1)} h  ${name}`);
  }

  console.log('\nCuadrícula importada:');
  for (const day of grid) {
    const line = day.classes
      .sort((a, b) => a.period - b.period)
      .map((item) => `${item.period}ª ${item.mappedName}`)
      .join(' · ');
    console.log(`  ${day.day.padEnd(10)} ${line}`);
  }
}

function minutesBetween(start, end) {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  return eh * 60 + em - (sh * 60 + sm);
}

main()
  .catch((error) => {
    console.error('FALLO:', error.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
