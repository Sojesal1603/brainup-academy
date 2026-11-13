'use server';

import { revalidatePath } from 'next/cache';
import { currentTenant } from './tenantContext';
import {
  isRecallRating,
  nextReviewLabel,
  scheduleSm2,
  type RecallRating,
} from './spacedRepetition';

export interface RateCardResult {
  success: boolean;
  error?: string;
  cardId?: string;
  rating?: RecallRating;
  intervalDays?: number;
  efactor?: number;
  dueAtIso?: string;
  dueLabel?: string;
  lapsed?: boolean;
}

/**
 * Valora una tarjeta y reprograma su próximo repaso con SM-2.
 *
 * La tarjeta tiene que existir: el id lo ha devuelto el servidor al generarla.
 * Si el navegador manda cualquier otra cosa, no se crea nada.
 */
export async function rateStudyCard(
  cardId: string,
  rating: string
): Promise<RateCardResult> {
  const { tenant: prisma } = await currentTenant();
  if (typeof cardId !== 'string' || cardId.length === 0) {
    return { success: false, error: 'Falta la tarjeta que has repasado.' };
  }
  if (!isRecallRating(rating)) {
    return { success: false, error: 'El nivel de recuerdo no es válido.' };
  }

  const card = await prisma.reviewCard.findUnique({
    where: { id: cardId },
    select: {
      id: true,
      repetition: true,
      intervalDays: true,
      efactor: true,
      dueAt: true,
      lastReviewedAt: true,
    },
  });

  if (!card) {
    return { success: false, error: 'Esa tarjeta ya no existe.' };
  }

  const now = new Date();
  const next = scheduleSm2(
    {
      repetition: card.repetition,
      intervalDays: card.intervalDays,
      efactor: card.efactor,
      dueAt: card.dueAt,
      lastReviewedAt: card.lastReviewedAt,
    },
    rating,
    now
  );

  await prisma.reviewCard.update({
    where: { id: card.id },
    data: {
      repetition: next.repetition,
      intervalDays: next.intervalDays,
      efactor: next.efactor,
      dueAt: next.dueAt,
      lastReviewedAt: next.lastReviewedAt,
      ...(next.lapsed ? { lapses: { increment: 1 } } : {}),
    },
  });

  revalidatePath('/');
  revalidatePath('/planificador');
  revalidatePath('/repaso');

  return {
    success: true,
    cardId: card.id,
    rating,
    intervalDays: next.intervalDays,
    efactor: next.efactor,
    dueAtIso: next.dueAt.toISOString(),
    dueLabel: nextReviewLabel(next.dueAt, now),
    lapsed: next.lapsed,
  };
}
