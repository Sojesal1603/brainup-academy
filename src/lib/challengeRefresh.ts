import { prisma } from './prisma';
import {
  buildWeeklyChallengeSeeds,
  challengeProgress,
  currentStudyStreak,
  isChallengeMet,
  weekEndOf,
  weekKeyOf,
  weekStartOf,
  type ChallengeKind,
  type WeeklyChallengeInput,
} from './challenges';
import { currentWeekWindow, loadWeekWorkData, previousWeekWindow } from './challengeWeek';
import { buildReviewQueue } from './srs';

/**
 * Generar, medir y cerrar los retos de la semana.
 *
 * Vive aquí, y **no** en la acción de servidor, por dos razones:
 *
 *   1. **Es lógica, no transporte.** La acción solo se encarga de revalidar las
 *      vistas de Next; el trabajo (consultar, medir, cerrar, pagar XP) es este
 *      módulo, y se puede ejecutar desde cualquier sitio: una acción, un script
 *      de verificación o el vigilante de mantenimiento.
 *   2. **Se puede probar de verdad.** Un módulo que importa `next/cache` no se
 *      puede ejecutar fuera de una petición, y entonces la única forma de
 *      comprobar que los retos se crean es a mano, con un navegador.
 *
 * Tres pasos, en este orden:
 *
 *   1. **Generarlos** desde lo que de verdad le falta al alumno (repasos
 *      vencidos, errores sin cerrar, el examen que tiene encima, sus horas
 *      declaradas). Si la semana ya tiene sus retos, no se duplican.
 *   2. **Medirlos** contra el trabajo hecho en la semana: repasos registrados,
 *      minutos de sesiones, errores cerrados, simulacros y puntos de nivel
 *      ganados. Nadie marca una casilla a mano. La racha sale de las sesiones
 *      reales, no del contador guardado: si el contador y la realidad no
 *      cuadran, manda la realidad (y así el reto se describe con lo mismo que
 *      luego se mide).
 *   3. **Cerrarlos**: el que llega a la meta queda conseguido y paga su XP (una
 *      sola vez); el que no, se queda «a medias» cuando la semana termina.
 *
 * El XP se suma al perfil al cerrar, y el nivel se deriva de él: no hay dos
 * números que puedan desincronizarse.
 */

export interface RefreshChallengesResult {
  success: boolean;
  error?: string;
  weekKey?: string;
  weekStartIso?: string;
  created: number;
  active: number;
  completed: number;
  expired: number;
  /** Retos de esta semana con su progreso, para poder pintarlos sin recargar. */
  progress: Array<{
    id: string;
    kind: string;
    title: string;
    description: string;
    unit: string;
    target: number;
    current: number;
    rewardXp: number;
    status: string;
    subjectName: string | null;
  }>;
  /** XP ganada en ESTA llamada (los retos recién cerrados). */
  earnedXp: number;
  totalXp: number;
}

export interface RefreshChallengesOptions {
  /** Fecha de referencia (las pruebas la fijan para no depender del día real). */
  now?: Date;
  /** Se llama si algo ha cambiado, para que quien invoque revalide sus vistas. */
  onChanged?: () => void | Promise<void>;
}

export async function refreshWeeklyChallenges(
  options: RefreshChallengesOptions = {}
): Promise<RefreshChallengesResult> {
  const empty: RefreshChallengesResult = {
    success: false,
    created: 0,
    active: 0,
    completed: 0,
    expired: 0,
    progress: [],
    earnedXp: 0,
    totalXp: 0,
  };

  try {
    const now = options.now ?? new Date();
    const { start: weekStart, end: weekEnd } = currentWeekWindow(now);
    const weekKey = weekKeyOf(now);
    const prevWeek = previousWeekWindow(now);

    const profile = await prisma.userProfile.findUnique({ where: { id: 'user_default' } });
    if (!profile) return { ...empty, error: 'No existe el perfil del alumno.' };

    const [subjects, measuredTopics, dueTopicRows, pendingErrors, closedErrorsLastWeek, upcomingExamRows] =
      await Promise.all([
        prisma.subject.findMany({ select: { id: true, name: true }, orderBy: { order: 'asc' } }),
        prisma.topic.findMany({
          where: { masterySource: { not: 'sin_medir' } },
          orderBy: { masteryLevel: 'asc' },
          take: 12,
          select: {
            id: true,
            title: true,
            unitNumber: true,
            masteryLevel: true,
            subjectId: true,
            subject: { select: { name: true } },
          },
        }),
        // Unidades con calendario de repaso: el vencimiento lo decide el motor SRS,
        // no una consulta que no sabe de intervalos.
        prisma.topic.findMany({
          where: { lastReviewedAt: { not: null } },
          select: { id: true, lastReviewedAt: true, srsIntervalDays: true, srsEaseFactor: true },
        }),
        prisma.errorLog.count({ where: { isMastered: false } }),
        prisma.errorLog.count({
          where: { isMastered: true, updatedAt: { gte: prevWeek.start, lt: prevWeek.end } },
        }),
        prisma.exam.findMany({
          where: { examDate: { gte: now } },
          orderBy: { examDate: 'asc' },
          take: 3,
          select: { title: true, examDate: true, subjectId: true, subject: { select: { name: true } } },
        }),
      ]);

    const dueReviews = buildReviewQueue(dueTopicRows, now, { onlyDue: true }).length;

    // La semana pasada: cuánto se hizo y cuántos retos se cerraron. Es lo que
    // decide si la meta de esta semana baja en vez de subir.
    const [prevSessions, prevReviews, prevChallenges] = await Promise.all([
      prisma.studySession.findMany({
        where: { startedAt: { gte: prevWeek.start, lt: prevWeek.end } },
        select: { minutesSpent: true },
      }),
      prisma.srsReview.count({
        where: { reviewedAt: { gte: prevWeek.start, lt: prevWeek.end } },
      }),
      prisma.weeklyChallenge.findMany({
        where: { weekKey: weekKeyOf(prevWeek.start) },
        select: { status: true },
      }),
    ]);

    const lastWeek =
      prevSessions.length > 0 || prevReviews > 0 || prevChallenges.length > 0
        ? {
            total: prevChallenges.length,
            completed: prevChallenges.filter((challenge) => challenge.status === 'completed').length,
            minutes: prevSessions.reduce((acc, session) => acc + session.minutesSpent, 0),
            reviews: prevReviews,
          }
        : null;

    // El trabajo real de la semana se carga ANTES de generar: la racha que entra
    // en los retos es la medida de las sesiones, no el contador del perfil, para
    // que la descripción del reto y su progreso digan lo mismo.
    const workData = await loadWeekWorkData({ start: weekStart, end: weekEnd });
    const measuredStreak = currentStudyStreak(workData.studyDays, now);

    const input: WeeklyChallengeInput = {
      subjects: subjects.map((subject) => ({ id: subject.id, name: subject.name })),
      measuredTopics: measuredTopics.map((topic) => ({
        id: topic.id,
        title: topic.title,
        unitNumber: topic.unitNumber,
        masteryLevel: topic.masteryLevel,
        subjectId: topic.subjectId,
        subjectName: topic.subject.name,
      })),
      dueReviews,
      pendingErrors,
      errorsClosedLastWeek: closedErrorsLastWeek,
      upcomingExams: upcomingExamRows.map((exam) => ({
        subjectId: exam.subjectId,
        subjectName: exam.subject.name,
        title: exam.title,
        days: Math.max(0, Math.round((exam.examDate.getTime() - now.getTime()) / 86400000)),
      })),
      weeklyHoursCap: profile.weeklyHoursCap,
      weeklyHoursDeclared: profile.weeklyHoursDeclared,
      streakCurrent: measuredStreak,
      lastWeek,
    };

    // 1. Crear los retos que falten. La comparación es explícita (y no un índice
    // único, que en SQLite no impide duplicados cuando hay NULL de por medio).
    const seeds = buildWeeklyChallengeSeeds(input);
    const existing = await prisma.weeklyChallenge.findMany({
      where: { weekKey },
      select: { kind: true, subjectId: true, topicId: true },
    });

    let created = 0;
    for (const seed of seeds) {
      const already = existing.some(
        (challenge) =>
          challenge.kind === seed.kind &&
          (challenge.subjectId ?? null) === seed.subjectId &&
          (challenge.topicId ?? null) === seed.topicId
      );
      if (already) continue;

      await prisma.weeklyChallenge.create({
        data: {
          weekKey,
          weekStart,
          kind: seed.kind,
          title: seed.title,
          description: seed.description,
          target: seed.target,
          unit: seed.unit,
          subjectId: seed.subjectId,
          topicId: seed.topicId,
          rewardXp: seed.rewardXp,
          status: 'active',
        },
      });
      created += 1;
    }

    // 2. Cerrar los que llegan a la meta y caducar los que ya no se miden.
    const weekChallenges = await prisma.weeklyChallenge.findMany({
      where: { weekKey },
      orderBy: { createdAt: 'asc' },
    });

    let earnedXp = 0;
    let active = 0;
    let completed = 0;
    let expiredThisWeek = 0;
    const progress: RefreshChallengesResult['progress'] = [];

    for (const challenge of weekChallenges) {
      const kind = (challenge.kind as ChallengeKind) ?? 'study_minutes';
      const current = challengeProgress(
        kind,
        { subjectId: challenge.subjectId, topicId: challenge.topicId },
        workData,
        now
      );

      let status = challenge.status;

      if (isChallengeMet(challenge.target, current)) {
        if (status !== 'completed') {
          await prisma.weeklyChallenge.update({
            where: { id: challenge.id },
            data: { status: 'completed', completedAt: now },
          });
          await prisma.userProfile.update({
            where: { id: profile.id },
            data: { challengeXp: { increment: challenge.rewardXp } },
          });
          earnedXp += challenge.rewardXp;
        }
        status = 'completed';
      } else if (now.getTime() >= weekEnd.getTime() && status === 'active') {
        // La semana ha terminado sin llegar: se dice y ya está.
        await prisma.weeklyChallenge.update({
          where: { id: challenge.id },
          data: { status: 'expired' },
        });
        status = 'expired';
        expiredThisWeek += 1;
      }

      if (status === 'active') active += 1;
      if (status === 'completed') completed += 1;

      progress.push({
        id: challenge.id,
        kind: challenge.kind,
        title: challenge.title,
        description: challenge.description,
        unit: challenge.unit,
        target: challenge.target,
        current,
        rewardXp: challenge.rewardXp,
        status,
        subjectName: challenge.subjectId
          ? subjects.find((subject) => subject.id === challenge.subjectId)?.name ?? null
          : null,
      });
    }

    // Un reto de una semana anterior que quedó «en juego» ya no volverá a medirse.
    const stale = await prisma.weeklyChallenge.updateMany({
      where: { status: 'active', weekStart: { lt: weekStart } },
      data: { status: 'expired' },
    });

    const updatedProfile = await prisma.userProfile.findUnique({
      where: { id: profile.id },
      select: { challengeXp: true },
    });

    if (options.onChanged) await options.onChanged();

    return {
      success: true,
      weekKey,
      weekStartIso: weekStart.toISOString(),
      created,
      active,
      completed,
      expired: stale.count + expiredThisWeek,
      progress,
      earnedXp,
      totalXp: updatedProfile?.challengeXp ?? profile.challengeXp,
    };
  } catch (error) {
    console.error('[retos] Error al generar o evaluar los retos:', error);
    return {
      ...empty,
      error: 'No se han podido generar los retos. Revisa la consola del servidor.',
    };
  }
}

/** Racha actual contada de las sesiones reales (para el resumen del Cuartel). */
export async function readCurrentStudyStreak(): Promise<number> {
  const sessions = await prisma.studySession.findMany({
    select: { startedAt: true },
    orderBy: { startedAt: 'desc' },
    take: 200,
  });

  const days: Date[] = [];
  for (const session of sessions) {
    const day = new Date(session.startedAt);
    day.setHours(0, 0, 0, 0);
    if (!days.some((existing) => existing.getTime() === day.getTime())) days.push(day);
  }

  return currentStudyStreak(days);
}

/** Reexportado para que un script pueda reutilizar la ventana de la semana. */
export { weekStartOf, weekEndOf };
