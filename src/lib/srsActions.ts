'use server';

import { revalidatePath, updateTag } from 'next/cache';
import { currentTenant } from './tenantContext';
import {
  applySrsReview,
  isMasteredInterval,
  isSrsRating,
  overdueDays,
  srsPriorityBonus,
  type SrsRating,
} from './srs';
import {
  initFsrsState,
  scheduleFsrs,
  TARGET_RETENTION,
  type FsrsRating,
} from './sessionEngine';

/**
 * Registrar un repaso espaciado.
 *
 * Es la única puerta por la que entra un repaso: valida el rating, guarda la
 * fila de historial (con el intervalo que llevabas y si lo recordabas) y
 * reprograma la unidad. La retención que se enseña en `/repaso` sale de estas
 * filas: si no se registran, no hay analítica, solo estimaciones.
 *
 * **No toca el dominio**: repasar no es lo mismo que saber. El nivel de una
 * unidad lo mueven las sesiones de estudio y los simulacros; aquí solo se
 * programa cuándo volver a preguntártelo.
 */

export interface RecordSrsReviewResult {
  success: boolean;
  error?: string;
  rating?: SrsRating;
  intervalDays?: number;
  easeFactor?: number;
  nextReviewAtIso?: string;
  recalled?: boolean;
  /** Memoria FSRS resultante: días hasta el 90% de recuerdo y dificultad 1-10. */
  stability?: number;
  difficulty?: number;
  /** La unidad ha pasado a «repasado» por tener ya un intervalo largo. */
  closed?: boolean;
  /** Prioridad que este repaso aporta al planificador (para poder verla). */
  priorityBonus?: number;
}

export async function recordSrsReview(input: {
  topicId: string;
  rating: string;
  minutesSpent?: number;
}): Promise<RecordSrsReviewResult> {
  const { tenant: prisma } = await currentTenant();
  const topicId = typeof input?.topicId === 'string' ? input.topicId : '';

  if (!topicId) {
    return { success: false, error: 'Falta la unidad que has repasado.' };
  }

  if (!isSrsRating(input?.rating)) {
    return { success: false, error: 'Cómo ha ido el repaso no es válido.' };
  }

  const rating = input.rating;

  const topic = await prisma.topic.findUnique({
    where: { id: topicId },
    select: {
      id: true,
      subjectId: true,
      status: true,
      lastReviewedAt: true,
      srsIntervalDays: true,
      srsEaseFactor: true,
      srsStability: true,
      srsDifficulty: true,
    },
  });

  if (!topic) {
    return { success: false, error: 'Esa unidad no existe.' };
  }

  const now = new Date();
  const intervalBeforeDays = topic.lastReviewedAt ? Math.max(0, topic.srsIntervalDays) : 0;
  const overdue = overdueDays(topic, now);

  const next = applySrsReview(
    {
      intervalDays: topic.srsIntervalDays,
      easeFactor: topic.srsEaseFactor,
      lastReviewedAt: topic.lastReviewedAt,
    },
    rating,
    now
  );

  // FSRS: además del intervalo clásico (que manda en el calendario y en la
  // vista de `/repaso`), se guarda la memoria medida —estabilidad y dificultad—.
  // Es lo que permite calcular la probabilidad de recuerdo EL DÍA DEL EXAMEN y
  // priorizar lo que de verdad se va a olvidar, no lo que toca por calendario.
  const fsrsState =
    topic.srsStability !== null && topic.srsDifficulty !== null
      ? { stability: topic.srsStability, difficulty: topic.srsDifficulty, lastReviewedAt: topic.lastReviewedAt }
      : initFsrsState(rating as FsrsRating);
  const fsrs = scheduleFsrs(fsrsState, rating as FsrsRating, now, TARGET_RETENTION);

  const meta = { again: 0, hard: 3, good: 4, easy: 5 } as const;
  const minutesSpent = Number.isFinite(input?.minutesSpent)
    ? Math.max(0, Math.round(Number(input.minutesSpent)))
    : 0;

  await prisma.srsReview.create({
    data: {
      topicId: topic.id,
      subjectId: topic.subjectId,
      reviewedAt: now,
      rating,
      quality: meta[rating],
      recalled: rating !== 'again',
      intervalBeforeDays,
      intervalAfterDays: next.intervalDays,
      easeAfter: next.easeFactor,
      overdueDays: overdue,
      minutesSpent,
    },
  });

  // Una unidad con un intervalo ya largo queda «repasada» en el temario. Nunca
  // se toca una unidad que aún no se ha dado en clase: eso sería mentir.
  const closed =
    isMasteredInterval(next.intervalDays) && topic.status !== 'pendiente' && topic.status !== 'repasado';

  await prisma.topic.update({
    where: { id: topic.id },
    data: {
      srsIntervalDays: next.intervalDays,
      srsEaseFactor: next.easeFactor,
      lastReviewedAt: now,
      srsStability: fsrs.stability,
      srsDifficulty: fsrs.difficulty,
      ...(closed ? { status: 'repasado' } : {}),
    },
  });

  updateTag('temario');
  updateTag('cuartel');
  revalidatePath('/repaso');
  revalidatePath('/');
  revalidatePath('/planificador');
  revalidatePath('/temario');
  revalidatePath('/estadisticas');

  return {
    success: true,
    rating,
    intervalDays: next.intervalDays,
    easeFactor: next.easeFactor,
    nextReviewAtIso: next.nextReviewAt.toISOString(),
    recalled: rating !== 'again',
    stability: fsrs.stability,
    difficulty: fsrs.difficulty,
    closed,
    priorityBonus: srsPriorityBonus({ lastReviewedAt: now, srsIntervalDays: next.intervalDays, srsEaseFactor: next.easeFactor }, now),
  };
}

/**
 * Borra el calendario de una unidad: vuelve a «nunca repasada» pero **conserva
 * el historial** de repasos (es evidencia de lo que has hecho, no un ajuste).
 * Sirve para empezar de cero cuando un intervalo se ha ido de las manos.
 */
export async function resetSrsSchedule(topicId: string): Promise<{ success: boolean; error?: string }> {
  const { tenant: prisma } = await currentTenant();
  if (typeof topicId !== 'string' || topicId.length === 0) {
    return { success: false, error: 'Falta la unidad.' };
  }

  const topic = await prisma.topic.findUnique({ where: { id: topicId }, select: { id: true } });
  if (!topic) return { success: false, error: 'Esa unidad no existe.' };

  await prisma.topic.update({
    where: { id: topicId },
    data: {
      srsIntervalDays: 1,
      srsEaseFactor: 2.5,
      lastReviewedAt: null,
    },
  });

  revalidatePath('/repaso');
  revalidatePath('/planificador');
  return { success: true };
}
