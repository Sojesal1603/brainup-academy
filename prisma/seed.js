/**
 * Semilla de BrainUp Academy.
 *
 * Tiene dos modos y una regla que no se salta nadie:
 *
 *   · `npm run db:seed`                 → datos de DEMOSTRACIÓN (materias de 1º de
 *     Bachillerato, un horario de clases, tres exámenes y cuatro hábitos de
 *     ejemplo). Está pensado para probar la app, no para estudiar de verdad.
 *   · `npm run db:seed -- --clean`      → solo la estructura real: perfil y las
 *     siete materias con su catedrático. **Nada inventado**: ni horario, ni
 *     exámenes, ni hábitos. Eso lo rellena la puesta a punto contigo, que es
 *     quien sabe tus horas, tus fechas y tu temario.
 *
 * Y la regla: si la base ya tiene trabajo tuyo (temario, apuntes o
 * conversaciones), el seed **se niega a ejecutarse** salvo que se le pase
 * `--force`. Antes borraba todo sin preguntar, y eso se llevó por delante un
 * curso entero. Ahora, además, siempre saca una copia de la base a
 * `data/backups/` antes de tocar nada, y `npm run db:restore` la devuelve.
 */

const { PrismaClient } = require('@prisma/client');
const { snapshotDatabase } = require('../scripts/db-backup.js');

const prisma = new PrismaClient();
const userId = process.env.BRAINUP_USER_ID?.trim();
if (!userId) {
  console.error('Falta BRAINUP_USER_ID: el seed necesita el UUID de la cuenta de Supabase Auth.');
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const clean = args.includes('--clean');
  const demo = !clean;

  // 0. ¿Hay algo que perder? Se mira antes de borrar nada.
  //
  // Lo que cuenta como «trabajo tuyo» es lo que solo se crea usando la app de
  // verdad: temario, apuntes, conversaciones, repasos hechos, errores apuntados
  // y sesiones de estudio. Los exámenes y el horario no cuentan porque el modo
  // de demostración también los crea: si contaran, no se podría volver a
  // sembrar una base de pruebas sin `--force`.
  const [topics, notes, conversations, srsReviews, errorLogs, sessions, profile] =
    await Promise.all([
      prisma.topic.count(),
      prisma.note.count(),
      prisma.aiConversation.count(),
      prisma.srsReview.count(),
      prisma.errorLog.count(),
      prisma.studySession.count(),
      prisma.userProfile.findUnique({ where: { id: userId } }),
    ]);

  const realData =
    topics > 0 ||
    notes > 0 ||
    conversations > 0 ||
    srsReviews > 0 ||
    errorLogs > 0 ||
    sessions > 0 ||
    Boolean(profile?.setupCompletedAt) ||
    Boolean(profile?.weeklyHoursDeclared);

  if (realData && !force) {
    console.error('');
    console.error('  ⛔ No he tocado nada: esta base ya tiene tu trabajo dentro.');
    console.error(`     · ${topics} unidades de temario`);
    console.error(`     · ${notes} apuntes`);
    console.error(`     · ${conversations} conversaciones con los catedráticos`);
    console.error(`     · ${srsReviews} repasos hechos y ${errorLogs} errores apuntados`);
    console.error('');
    console.error('     El seed borra todo eso para dejar los datos de ejemplo.');
    console.error('     Si de verdad quieres empezar de cero:  npm run db:seed -- --force');
    console.error('     Y para guardar antes una copia:        npm run db:backup');
    console.error('');
    process.exit(1);
  }

  // 1. Copia de seguridad SIEMPRE, antes de borrar. Es reversible.
  const snapshot = await snapshotDatabase(force ? 'antes-del-seed-forzado' : 'antes-del-seed');
  if (snapshot) {
    console.log(`· Copia de la base antes de tocar nada: ${snapshot}`);
  }

  console.log(
    clean
      ? '--- BrainUp Academy: estructura limpia (sin datos inventados) ---'
      : '--- BrainUp Academy: datos de DEMOSTRACIÓN (no es un curso real) ---'
  );

  // 2. Limpieza de tablas
  await prisma.classPeriod.deleteMany({ where: { userId } });
  await prisma.moodleTask.deleteMany({ where: { userId } });
  await prisma.note.deleteMany({ where: { userId } });
  await prisma.pauExamSession.deleteMany({ where: { userId } });
  await prisma.aiMessage.deleteMany({ where: { userId } });
  await prisma.aiConversation.deleteMany({ where: { userId } });
  await prisma.aiAgent.deleteMany({ where: { userId } });
  await prisma.habitLog.deleteMany({ where: { userId } });
  await prisma.habit.deleteMany({ where: { userId } });
  await prisma.errorLog.deleteMany({ where: { userId } });
  await prisma.studySession.deleteMany({ where: { userId } });
  await prisma.studyBlock.deleteMany({ where: { userId } });
  await prisma.exam.deleteMany({ where: { userId } });
  await prisma.topic.deleteMany({ where: { userId } });
  await prisma.subject.deleteMany({ where: { userId } });
  await prisma.userProfile.deleteMany({ where: { id: userId } });

  // 3. Perfil. En modo limpio no se inventa ni la racha ni un calendario de
  // Moodle: la puesta a punto pregunta las horas reales y la app mide el resto.
  const user = await prisma.userProfile.create({
    data: {
      id: userId,
      name: 'Santiago',
      modality: '1º de Bachillerato (Ciencias y Tecnología)',
      targetGradePau: 13.5,
      weeklyHoursCap: 25.0,
      weeklyHoursDeclared: false,
      studyMode: 'athlete',
      ...(demo
        ? {
            streakCurrent: 5,
            streakBest: 9,
            lastStudyDate: new Date(),
            moodleFeedUrl:
              'https://moodle.instituto.educamadrid.org/calendar/export_execute.php?userid=santiago&authtoken=demo123',
          }
        : {}),
    },
  });

  // 4. Asignaturas de 1º de Bachillerato (con Tecnología e Ingeniería I)
  const subjectsData = [
    {
      name: 'Matemáticas I',
      color: '#3b82f6', // Azul
      pauWeight: 0.2,
      isPhaseGeneral: false,
      currentGrade: 7.5,
      targetGrade: 9.5,
      totalHoursSpent: 18.0,
      order: 1,
      agentPrompt:
        'Eres el Catedrático de Matemáticas I para 1º de Bachillerato. Enseñas a asentar las bases algebraicas, trigonométricas y analíticas para selectividad. No des la solución: exige planteamiento vectorial y justificación.',
    },
    {
      name: 'Física y Química',
      color: '#8b5cf6', // Violeta
      pauWeight: 0.2,
      isPhaseGeneral: false,
      currentGrade: 7.0,
      targetGrade: 9.25,
      totalHoursSpent: 16.5,
      order: 2,
      agentPrompt:
        'Eres el Catedrático de Física y Química de 1º de Bachillerato. Exiges rigor con diagramas de cuerpo libre, unidades del Sistema Internacional y factores de conversión molares.',
    },
    {
      name: 'Tecnología e Ingeniería I',
      color: '#06b6d4', // Cian brillante
      pauWeight: 0.2,
      isPhaseGeneral: false,
      currentGrade: 8.0,
      targetGrade: 9.75,
      totalHoursSpent: 15.0,
      order: 3,
      agentPrompt:
        'Eres el Catedrático de Tecnología e Ingeniería I para 1º de Bachillerato. Fomentas el cálculo técnico exacto (rendimientos, relaciones de transmisión, mallas de Kirchhoff) y el diseño de esquemas normalizados con criterio ingenieril.',
    },
    {
      name: 'Filosofía',
      color: '#f59e0b', // Ámbar
      pauWeight: 0.0,
      isPhaseGeneral: true,
      currentGrade: 8.2,
      targetGrade: 9.5,
      totalHoursSpent: 12.0,
      order: 4,
      agentPrompt:
        'Eres el Catedrático de Filosofía de 1º de Bachillerato. Enseñas argumentación crítica, distinción entre premisas y falacias, y redacción de disertaciones impecables.',
    },
    {
      name: 'Lengua Castellana y Literatura I',
      color: '#ec4899', // Rosa
      pauWeight: 0.0,
      isPhaseGeneral: true,
      currentGrade: 8.0,
      targetGrade: 9.0,
      totalHoursSpent: 11.0,
      order: 5,
      agentPrompt:
        'Eres el Catedrático de Lengua y Literatura I. Tu foco es el análisis sintáctico exacto, la coherencia de redacción y el comentario filológico de obras literarias.',
    },
    {
      name: 'Inglés I',
      color: '#10b981', // Verde
      pauWeight: 0.0,
      isPhaseGeneral: true,
      currentGrade: 8.8,
      targetGrade: 9.75,
      totalHoursSpent: 9.0,
      order: 6,
      agentPrompt:
        'You are the English Professor for Bachillerato. You help master formal academic English, C1 linkers, flawless essay structures and error correction.',
    },
    {
      name: 'Dibujo Técnico I',
      color: '#f97316', // Naranja técnico
      pauWeight: 0.2,
      isPhaseGeneral: false,
      currentGrade: 8.5,
      targetGrade: 9.5,
      totalHoursSpent: 14.0,
      order: 7,
      agentPrompt:
        'Eres el Catedrático de Dibujo Técnico I de 1º de Bachillerato. Exiges precisión matemática en los trazados, interpretación espacial impecable en diédrico y rigor en las tangencias.',
    },
  ];

  const createdSubjects = [];
  for (const s of subjectsData) {
    const subject = await prisma.subject.create({
      data: {
        userId,
        name: s.name,
        color: s.color,
        pauWeight: s.pauWeight,
        isPhaseGeneral: s.isPhaseGeneral,
        currentGrade: s.currentGrade,
        targetGrade: s.targetGrade,
        totalHoursSpent: s.totalHoursSpent,
        order: s.order,
      },
    });

    // Catedrático
    await prisma.aiAgent.create({
      data: {
        userId,
        subjectId: subject.id,
        name: `Catedrático de ${s.name}`,
        specialty: `Dominio curricular y preparación estratégica de 1º de Bachillerato para ${s.name}`,
        systemPrompt: s.agentPrompt,
      },
    });

    // Temario: no se inventa. Lo cargas tú desde /temario con el índice real
    // de tu profesor o de tu libro, y queda guardado con su origen y sin nivel
    // de partida (cargar el temario no es saberlo).
    createdSubjects.push({ subject });
  }

  // 5. Apuntes: tampoco se inventan. Se escriben desde /apuntes, colgados de
  // las unidades de tu temario real.

  if (demo) {
    // 6. Horario Escolar de Clases (Lunes a Viernes, 6 periodos lectivos).
    //    OJO: es un horario de EJEMPLO. El horario real lo importa el alumno
    //    desde /horario o lo dicta en la puesta a punto.
    const mathSub = createdSubjects[0].subject;
    const fqSub = createdSubjects[1].subject;
    const tecSub = createdSubjects[2].subject;
    const filoSub = createdSubjects[3].subject;
    const lenSub = createdSubjects[4].subject;
    const ingSub = createdSubjects[5].subject;

    const periodsTemplate = [
      { period: 1, startTime: '08:15', endTime: '09:10' },
      { period: 2, startTime: '09:10', endTime: '10:05' },
      { period: 3, startTime: '10:05', endTime: '11:00' },
      // Recreo 11:00 - 11:30
      { period: 4, startTime: '11:30', endTime: '12:25' },
      { period: 5, startTime: '12:25', endTime: '13:20' },
      { period: 6, startTime: '13:20', endTime: '14:15' },
    ];

    const timetable = [
      // Lunes
      { day: 1, p: 1, sub: mathSub.id, room: 'Aula 104' },
      { day: 1, p: 2, sub: tecSub.id, room: 'Taller Tec' },
      { day: 1, p: 3, sub: fqSub.id, room: 'Lab Física' },
      { day: 1, p: 4, sub: filoSub.id, room: 'Aula 104' },
      { day: 1, p: 5, sub: lenSub.id, room: 'Aula 104' },
      { day: 1, p: 6, sub: ingSub.id, room: 'Aula Idiomas' },
      // Martes
      { day: 2, p: 1, sub: fqSub.id, room: 'Lab Física' },
      { day: 2, p: 2, sub: mathSub.id, room: 'Aula 104' },
      { day: 2, p: 3, sub: tecSub.id, room: 'Taller Tec' },
      { day: 2, p: 4, sub: lenSub.id, room: 'Aula 104' },
      { day: 2, p: 5, sub: ingSub.id, room: 'Aula Idiomas' },
      { day: 2, p: 6, sub: filoSub.id, room: 'Aula 104' },
      // Miércoles
      { day: 3, p: 1, sub: mathSub.id, room: 'Aula 104' },
      { day: 3, p: 2, sub: tecSub.id, room: 'Taller Tec' },
      { day: 3, p: 3, sub: fqSub.id, room: 'Aula 104' },
      { day: 3, p: 4, sub: filoSub.id, room: 'Aula 104' },
      { day: 3, p: 5, sub: lenSub.id, room: 'Aula 104' },
      { day: 3, p: 6, sub: ingSub.id, room: 'Aula Idiomas' },
      // Jueves
      { day: 4, p: 1, sub: tecSub.id, room: 'Taller Tec' },
      { day: 4, p: 2, sub: mathSub.id, room: 'Aula 104' },
      { day: 4, p: 3, sub: fqSub.id, room: 'Lab Química' },
      { day: 4, p: 4, sub: lenSub.id, room: 'Aula 104' },
      { day: 4, p: 5, sub: filoSub.id, room: 'Aula 104' },
      { day: 4, p: 6, sub: ingSub.id, room: 'Aula Idiomas' },
      // Viernes
      { day: 5, p: 1, sub: mathSub.id, room: 'Aula 104' },
      { day: 5, p: 2, sub: fqSub.id, room: 'Lab Física' },
      { day: 5, p: 3, sub: tecSub.id, room: 'Taller Tec' },
      { day: 5, p: 4, sub: ingSub.id, room: 'Aula Idiomas' },
      { day: 5, p: 5, sub: lenSub.id, room: 'Aula 104' },
      { day: 5, p: 6, sub: filoSub.id, room: 'Aula 104' },
    ];

    for (const item of timetable) {
      const periodInfo = periodsTemplate[item.p - 1];
      await prisma.classPeriod.create({
        data: {
          userId,
          dayOfWeek: item.day,
          period: item.p,
          startTime: periodInfo.startTime,
          endTime: periodInfo.endTime,
          subjectId: item.sub,
          classroom: item.room,
        },
      });
    }

    // 7. Tareas de ejemplo de Moodle (con URL de mentira, para poder verlas).
    const now = new Date();
    await prisma.moodleTask.create({
      data: {
        userId,
        title: 'Boletín 3: Asociación de Resistencias y Leyes de Kirchhoff',
        description:
          'Resolver los ejercicios 1 al 8 de la ficha subida a Moodle. Justificar los cálculos de potencia.',
        courseName: 'Tecnología e Ingeniería I',
        dueDate: new Date(now.getTime() + 4 * 86400000),
        isCompleted: false,
        moodleUrl: 'https://moodle.instituto.educamadrid.org/mod/assign/view.php?id=1024',
      },
    });

    await prisma.moodleTask.create({
      data: {
        userId,
        title: 'Problemas de Dinámica: Plano Inclinado con Rozamiento',
        description:
          'Entregar en PDF el diagrama de cuerpo libre y las ecuaciones escalares de los ejercicios 12 y 14.',
        courseName: 'Física y Química',
        dueDate: new Date(now.getTime() + 7 * 86400000),
        isCompleted: false,
        moodleUrl: 'https://moodle.instituto.educamadrid.org/mod/assign/view.php?id=1089',
      },
    });

    await prisma.moodleTask.create({
      data: {
        userId,
        title: 'Disertación Filosófica: ¿Es la Ciencia un Saber Infalible?',
        description:
          'Extensión máxima de 2 caras. Utilizar la crítica inductivista de Popper o el empirismo de Hume.',
        courseName: 'Filosofía',
        dueDate: new Date(now.getTime() + 10 * 86400000),
        isCompleted: false,
        moodleUrl: 'https://moodle.instituto.educamadrid.org/mod/assign/view.php?id=1130',
      },
    });

    // 8. Exámenes de EJEMPLO. Son de mentira: fechas inventadas a partir de hoy.
    //    Los de verdad los apunta el alumno (o el coordinador en la puesta a
    //    punto, con la fecha que él diga).
    await prisma.exam.create({
      data: {
        userId,
        subjectId: mathSub.id,
        title: 'Examen 2ª Evaluación: Trigonometría y Vectores',
        examDate: new Date(now.getTime() + 8 * 86400000),
        weightPercent: 35.0,
        examType: 'parcial',
        targetGrade: 9.5,
        notes: 'Triángulos oblicuángulos, identidades trigonométricas y producto escalar.',
      },
    });

    await prisma.exam.create({
      data: {
        userId,
        subjectId: tecSub.id,
        title: 'Examen Trimestral: Ensayos de Tracción y Circuitos',
        examDate: new Date(now.getTime() + 12 * 86400000),
        weightPercent: 30.0,
        examType: 'parcial',
        targetGrade: 9.75,
        notes: 'Diagrama tensión-deformación, módulo de Young y resolución de mallas.',
      },
    });

    await prisma.exam.create({
      data: {
        userId,
        subjectId: fqSub.id,
        title: 'Parcial Trimestral: Dinámica de Newton y Trabajo/Energía',
        examDate: new Date(now.getTime() + 16 * 86400000),
        weightPercent: 30.0,
        examType: 'parcial',
        targetGrade: 9.0,
        notes: 'Plano inclinado con rozamiento y conservación de energía mecánica.',
      },
    });

    // 9. Hábitos de ejemplo.
    const habits = [
      {
        title: '25 min Active Recall al despertar',
        description: 'Revisar fórmulas o conceptos sin mirar apuntes',
        streak: 5,
      },
      {
        title: 'Revisar tareas de Moodle y pulir 1 apunte Notion',
        description: 'Sintetizar la clase de hoy con ejemplos y fórmulas',
        streak: 4,
      },
      {
        title: '1 problema de Tecnología, Mates o Física con cronómetro',
        description: 'Poner a prueba velocidad de cálculo sin atajos',
        streak: 6,
      },
      {
        title: 'Revisión y calibración de agenda en el Cuartel',
        description: 'Comprobar horario de clases para mañana y bloques de estudio',
        streak: 7,
      },
    ];

    for (const h of habits) {
      await prisma.habit.create({ data: { ...h, userId } });
    }
  }

  console.log('✅ Base de datos preparada.');
  console.log(`   · Perfil: ${user.name}`);
  console.log(`   · ${createdSubjects.length} materias con su catedrático`);
  if (demo) {
    console.log('   · Horario de clases, 3 exámenes, 3 tareas de Moodle y 4 hábitos: SON DE EJEMPLO');
    console.log('     (sus fechas se inventan a partir de hoy; bórralos cuando tengas los tuyos)');
  } else {
    console.log('   · Sin horario, sin exámenes y sin hábitos inventados: eso lo rellena la');
    console.log('     puesta a punto (/puesta-a-punto) con lo que digas tú.');
  }
  console.log('   · Temario, apuntes y plan: vacíos hasta que los cargues tú');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
