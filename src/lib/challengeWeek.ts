import { db } from './db';
import { weekEndOf, weekStartOf, type WeekWorkData } from './challenges';

/**
 * El trabajo real de una semana, agregado.
 *
 * Lo usan **dos sitios**: la acción que cierra los retos y la página que los
 * pinta. Vive aquí, y no duplicado en cada uno, porque el día que la definición
 * de «un repaso cuenta» cambie tiene que cambiar en un solo sitio: si la página
 * midiera distinto que el motor de cierre, el reto se vería al 90% en pantalla y
 * se cerraría como conseguido, o al revés.
 *
 * Es lógica de servidor (consulta Prisma), así que este módulo no lleva
 * `'use server'`: no es una acción que el navegador pueda invocar.
 */

export interface WeekWindow {
  start: Date;
  end: Date;
}

export function currentWeekWindow(now: Date = new Date()): WeekWindow {
  return { start: weekStartOf(now), end: weekEndOf(now) };
}

export function previousWeekWindow(now: Date = new Date()): WeekWindow {
  const { start } = currentWeekWindow(now);
  return { start: new Date(start.getTime() - 7 * 86400000), end: start };
}

/**
 * Empareja una sesión de simulacro (que solo guarda el nombre de la materia en
 * texto) con la asignatura real. Sin esto, un reto «haz un simulacro de
 * Matemáticas» nunca contaría: el simulacro no trae el id.
 */
export function matchSubjectByName(
  subjects: Array<{ id: string; name: string }>,
  subjectName: string
): string | null {
  const needle = String(subjectName ?? '').toLowerCase().trim();
  if (!needle) return null;

  const exact = subjects.find((subject) => subject.name.toLowerCase() === needle);
  if (exact) return exact.id;

  const partial = subjects.find(
    (subject) =>
      needle.includes(subject.name.toLowerCase()) || subject.name.toLowerCase().includes(needle)
  );
  return partial?.id ?? null;
}

/** Días de historia que se miran para la racha (cruza de una semana a otra). */
const STREAK_HORIZON_DAYS = 90;

/** Todo lo que ha pasado en la ventana dada, listo para `challengeProgress`. */
export async function loadWeekWorkData(userId: string, window: WeekWindow): Promise<WeekWorkData> {
  const prisma = db(userId);
  const [subjects, reviews, sessions, closedErrors, simulacros, streakSessions] = await Promise.all([
    prisma.subject.findMany({ select: { id: true, name: true } }),
    prisma.srsReview.findMany({
      where: { reviewedAt: { gte: window.start, lt: window.end } },
      select: { topicId: true, subjectId: true },
    }),
    prisma.studySession.findMany({
      where: { startedAt: { gte: window.start, lt: window.end } },
      select: {
        startedAt: true,
        minutesSpent: true,
        previousMastery: true,
        newMastery: true,
        topicId: true,
        topic: { select: { subjectId: true } },
      },
    }),
    prisma.errorLog.findMany({
      where: { isMastered: true, updatedAt: { gte: window.start, lt: window.end } },
      select: { subjectId: true },
    }),
    prisma.pauExamSession.findMany({
      where: { isCompleted: true, createdAt: { gte: window.start, lt: window.end } },
      select: { subjectName: true },
    }),
    // La racha NO se limita a la semana: una racha de seis días que empezó el
    // viernes pasado cuenta entera. Se mira hacia atrás un trimestre.
    prisma.studySession.findMany({
      where: { startedAt: { gte: new Date(window.start.getTime() - STREAK_HORIZON_DAYS * 86400000) } },
      select: { startedAt: true },
      orderBy: { startedAt: 'desc' },
      take: 600,
    }),
  ]);

  const studyDays: Date[] = [];
  for (const session of streakSessions) {
    const day = new Date(session.startedAt);
    day.setHours(0, 0, 0, 0);
    if (!studyDays.some((existing) => existing.getTime() === day.getTime())) {
      studyDays.push(day);
    }
  }

  return {
    reviews: reviews.map((review) => ({ topicId: review.topicId, subjectId: review.subjectId })),
    sessions: sessions.map((session) => ({
      topicId: session.topicId,
      subjectId: session.topic.subjectId,
      minutes: session.minutesSpent,
      masteryDelta: Math.max(0, session.newMastery - session.previousMastery),
    })),
    closedErrors: closedErrors.map((error) => ({ subjectId: error.subjectId })),
    simulacros: simulacros.map((session) => ({
      subjectId: matchSubjectByName(subjects, session.subjectName),
      subjectName: session.subjectName,
    })),
    studyDays,
  };
}

/** Racha de días de estudio contados de las sesiones reales, no del contador. */
export async function loadStudyDays(userId: string, limit = 200): Promise<Date[]> {
  const prisma = db(userId);
  const sessions = await prisma.studySession.findMany({
    select: { startedAt: true },
    orderBy: { startedAt: 'desc' },
    take: limit,
  });

  const days: Date[] = [];
  for (const session of sessions) {
    const day = new Date(session.startedAt);
    day.setHours(0, 0, 0, 0);
    if (!days.some((existing) => existing.getTime() === day.getTime())) days.push(day);
  }
  return days;
}
