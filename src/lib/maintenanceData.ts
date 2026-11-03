import { prisma } from './prisma';
import { weekKeyOf } from './challenges';
import { getCandidateChain, getConfiguredProviders, getCooldownSeconds } from './aiEngine';
import { loadOperationalTrace } from './operationalData';
import { listTemarioBackups } from './temarioRestore';
import type { MaintenanceInput } from './maintenance';

/**
 * Qué hallazgo del vigilante abrió una incidencia (o `null` si la abrió alguien).
 *
 * Se lee de su `contextJson` y **nunca puede tumbar la revisión**: una incidencia
 * con el contexto corrupto se queda sin hallazgo, que es como decir «no sé de qué
 * viene», y aun así se cuenta igual que las demás.
 */
function findingIdOf(contextJson: string | null): string | null {
  if (!contextJson) return null;
  try {
    const parsed = JSON.parse(contextJson) as { findingId?: unknown };
    return typeof parsed.findingId === 'string' && parsed.findingId.length > 0 ? parsed.findingId : null;
  } catch {
    return null;
  }
}

/** Clave para comparar nombres de materia sin depender de acentos ni mayúsculas. */
function subjectKey(name: string): string {
  return String(name ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Los datos que mira el taller de mantenimiento.
 *
 * Vive aparte de las acciones por la misma razón que el resto de cargadores del
 * proyecto: la página y el vigilante tienen que ver **exactamente lo mismo**, y
 * eso solo se garantiza si lo carga el mismo código. Este módulo no lleva
 * `'use server'`: no es una acción, es una consulta.
 */

/**
 * Cuántos apuntes mira la revisión, los más recientes primero.
 *
 * El taller busca restos de código **dentro** del texto de cada apunte, así que
 * necesita el contenido entero: con un tope se evita que una biblioteca enorme
 * (cientos de apuntes de Moodle) haga pesada cada ronda del vigilante. Lo que no
 * entra en esta pasada entra en la siguiente en cuanto se actualice.
 */
const MAX_NOTES_REVIEWED = 200;

export async function loadMaintenanceInput(now: Date = new Date()): Promise<MaintenanceInput> {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today.getTime() + 86400000);

  const [topics, subjects, exams, habits, challenges, issues, notes] = await Promise.all([
    prisma.topic.findMany({
      select: {
        id: true,
        subjectId: true,
        title: true,
        unitNumber: true,
        status: true,
        lastReviewedAt: true,
        srsIntervalDays: true,
        srsEaseFactor: true,
        masteryLevel: true,
        masterySource: true,
        subject: { select: { name: true } },
        _count: {
          select: { notes: true, errors: true, studyBlocks: true, sessions: true, srsReviews: true },
        },
      },
      orderBy: [{ subject: { order: 'asc' } }, { unitNumber: 'asc' }],
    }),
    prisma.subject.findMany({
      select: { id: true, name: true, order: true, isTracked: true, _count: { select: { topics: true, classPeriods: true } } },
      orderBy: { order: 'asc' },
    }),
    prisma.exam.findMany({
      select: { id: true, title: true, examDate: true, isCompleted: true, subject: { select: { name: true } } },
      orderBy: { examDate: 'asc' },
    }),
    prisma.habit.findMany({
      select: { id: true, title: true, streak: true },
    }),
    prisma.weeklyChallenge.findMany({
      select: { id: true, weekKey: true, weekStart: true, status: true, title: true },
    }),
    prisma.systemIssue.findMany({
      select: { id: true, title: true, status: true, contextJson: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
    prisma.note.findMany({
      select: { id: true, title: true, content: true, author: true },
      orderBy: { updatedAt: 'desc' },
      take: MAX_NOTES_REVIEWED,
    }),
  ]);

  // Registros de hábito de hoy: se conserva uno por hábito y se anotan los
  // sobrantes (con su id) para poder borrarlos sin adivinar.
  const todayLogs = await prisma.habitLog.findMany({
    where: { date: { gte: today, lt: tomorrow } },
    select: { id: true, habitId: true },
    orderBy: { id: 'asc' },
  });

  const logsByHabit = new Map<string, string[]>();
  for (const log of todayLogs) {
    logsByHabit.set(log.habitId, [...(logsByHabit.get(log.habitId) ?? []), log.id]);
  }

  const habitRows = habits.map((habit) => {
    const ids = logsByHabit.get(habit.id) ?? [];
    return {
      id: habit.id,
      title: habit.title,
      streak: habit.streak,
      logsToday: ids.length,
      extraLogIds: ids.slice(1),
    };
  });

  /*
   * Copias del temario disponibles.
   *
   * Se leen del disco (son ficheros de `data/backups/`) y **nunca** pueden tumbar
   * la revisión: si algo falla, se sigue sin copias y el taller simplemente no
   * ofrece reponer nada. Lo que no puede pasar es que la ronda entera se caiga
   * porque un fichero de respaldo esté a medias.
   *
   * Es lo que permite distinguir «esta materia aún no tiene temario» (normal) de
   * «esta materia se ha quedado sin temario y antes sí lo tenía» (una pérdida que
   * el sistema sabe reparar solo).
   */
  const backupBySubject = new Map<string, { units: number; file: string }>();
  try {
    for (const backup of listTemarioBackups()) {
      for (const name of backup.subjects) {
        const key = subjectKey(name);
        const current = backupBySubject.get(key);
        if (!current || backup.units > current.units) {
          backupBySubject.set(key, { units: backup.units, file: backup.file });
        }
      }
    }
  } catch {
    backupBySubject.clear();
  }

  // Estado del motor de IA: cuántos candidatos hay libres y cuántos en enfriamiento.
  let availableModels = 0;
  let coolingDown = 0;
  try {
    const chain = await getCandidateChain();
    availableModels = chain.filter((candidate) => getCooldownSeconds(candidate.key) === 0).length;
    coolingDown = chain.filter((candidate) => getCooldownSeconds(candidate.key) > 0).length;
  } catch {
    availableModels = 0;
  }

  const configured = getConfiguredProviders();

  // Cómo va la app por dentro. Se lee aquí (y no en el motor) porque el motor es
  // puro: así la página y el vigilante ven exactamente el mismo rastro.
  const trace = await loadOperationalTrace(now);

  return {
    today: today.toISOString(),
    now: now.toISOString(),
    trace,
    weekKey: weekKeyOf(now),
    topics: topics.map((topic) => ({
      id: topic.id,
      subjectId: topic.subjectId,
      subjectName: topic.subject.name,
      title: topic.title,
      unitNumber: topic.unitNumber,
      status: topic.status,
      lastReviewedAt: topic.lastReviewedAt ? topic.lastReviewedAt.toISOString() : null,
      srsIntervalDays: topic.srsIntervalDays,
      srsEaseFactor: topic.srsEaseFactor,
      masteryLevel: topic.masteryLevel,
      masterySource: topic.masterySource,
      attached: {
        notes: topic._count.notes,
        errors: topic._count.errors,
        blocks: topic._count.studyBlocks,
        sessions: topic._count.sessions,
        reviews: topic._count.srsReviews,
      },
    })),
    subjects: subjects.map((subject) => {
      const copy = backupBySubject.get(subjectKey(subject.name));
      return {
        id: subject.id,
        name: subject.name,
        order: subject.order,
        units: subject._count.topics,
        classPeriods: subject._count.classPeriods,
        tracked: subject.isTracked,
        ...(copy ? { backupUnits: copy.units, backupFrom: copy.file } : {}),
      };
    }),
    exams: exams.map((exam) => ({
      id: exam.id,
      title: exam.title,
      subjectName: exam.subject.name,
      examDate: exam.examDate.toISOString(),
      isCompleted: exam.isCompleted,
    })),
    habits: habitRows,
    challenges: challenges.map((challenge) => ({
      id: challenge.id,
      weekKey: challenge.weekKey,
      weekStart: challenge.weekStart.toISOString(),
      status: challenge.status,
      title: challenge.title,
    })),
    issues: issues.map((issue) => ({
      id: issue.id,
      title: issue.title,
      status: issue.status,
      findingId: findingIdOf(issue.contextJson),
    })),
    notes: notes.map((note) => ({
      id: note.id,
      title: note.title,
      content: note.content,
      author: note.author,
    })),
    ai: {
      gemini: configured.includes('gemini'),
      groq: configured.includes('groq'),
      availableModels,
      coolingDown,
    },
  };
}
