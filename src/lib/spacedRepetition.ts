/**
 * Repetición espaciada por tarjeta: SuperMemo-2 (SM-2), sin atajos.
 *
 * El motor de `srs.ts` programa **unidades enteras**; este programa cada
 * flashcard, concepto o pregunta de test. Son dos granularidades distintas y
 * las dos hacen falta: la unidad decide qué toca estudiar y la tarjeta decide
 * qué concepto concreto has olvidado.
 *
 * Reglas del SM-2 clásico:
 *
 *   - `again` (calidad 1) → se olvidó: repeticiones a 0, intervalo 1 día.
 *   - `hard`  (calidad 3) → cuesta, pero se recuerda: el intervalo avanza.
 *   - `good`  (calidad 4) → avanza con el factor de facilidad.
 *   - `easy`  (calidad 5) → avanza y el factor sube.
 *   - `efactor = max(1.3, ef + 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))`.
 *   - Intervalos: 1 día → 6 días → intervalo anterior × efactor.
 *
 * Módulo puro: no toca Prisma ni la red, así que se puede probar y razonar sin
 * base de datos.
 */

export type RecallRating = 'again' | 'hard' | 'good' | 'easy';

export const RECALL_RATING_ORDER: RecallRating[] = ['again', 'hard', 'good', 'easy'];

export const RECALL_RATINGS: Record<
  RecallRating,
  { label: string; quality: number; color: string; description: string }
> = {
  again: {
    label: 'Otra vez',
    quality: 1,
    color: 'rose',
    description: 'No lo recordaba: vuelve mañana y reinicia el intervalo.',
  },
  hard: {
    label: 'Difícil',
    quality: 3,
    color: 'amber',
    description: 'Lo he sacado con esfuerzo: el intervalo avanza poco.',
  },
  good: {
    label: 'Bien',
    quality: 4,
    color: 'emerald',
    description: 'Lo recordaba sin ayuda: avanza con el factor de facilidad.',
  },
  easy: {
    label: 'Fácil',
    quality: 5,
    color: 'sky',
    description: 'Lo tenía dominado: el intervalo se estira y la facilidad sube.',
  },
};

export const SM2_MIN_EFACTOR = 1.3;
export const SM2_MAX_INTERVAL_DAYS = 365;

export interface Sm2State {
  repetition: number;
  intervalDays: number;
  efactor: number;
  dueAt: Date;
  lastReviewedAt: Date | null;
}

export interface Sm2Schedule extends Sm2State {
  quality: number;
  /** ¿Se ha fallado y reiniciado el intervalo? */
  lapsed: boolean;
}

export function isRecallRating(value: unknown): value is RecallRating {
  return (
    typeof value === 'string' &&
    (RECALL_RATING_ORDER as string[]).includes(value)
  );
}

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Tarjeta recién creada: vence hoy, sin historial. */
export function initialSm2State(now: Date = new Date()): Sm2State {
  return {
    repetition: 0,
    intervalDays: 0,
    efactor: 2.5,
    dueAt: startOfDay(now),
    lastReviewedAt: null,
  };
}

/**
 * Aplica una valoración de recuerdo y devuelve el estado siguiente.
 *
 * `dueAt` cae a medianoche local del día que toca: así «vence hoy» significa lo
 * mismo para el plan, la cola de repaso y la interfaz, sin depender de la hora
 * exacta a la que el alumno pulsó el botón.
 */
export function scheduleSm2(
  state: Sm2State,
  rating: RecallRating,
  now: Date = new Date()
): Sm2Schedule {
  const meta = RECALL_RATINGS[rating];
  const quality = meta.quality;
  const previousInterval = state.lastReviewedAt
    ? Math.max(0, Math.round(state.intervalDays))
    : 0;

  const rawEfactor =
    state.efactor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
  const efactor = Math.round(
    clamp(Number.isFinite(rawEfactor) ? rawEfactor : 2.5, SM2_MIN_EFACTOR, 2.8) * 100
  ) / 100;

  const lapsed = quality < 3;
  let repetition: number;
  let intervalDays: number;

  if (lapsed) {
    repetition = 0;
    intervalDays = 1;
  } else {
    repetition = Math.max(0, state.repetition) + 1;
    if (repetition === 1) {
      intervalDays = 1;
    } else if (repetition === 2) {
      intervalDays = 6;
    } else {
      intervalDays = Math.round(Math.max(1, previousInterval) * efactor);
    }
    intervalDays = clamp(intervalDays, 1, SM2_MAX_INTERVAL_DAYS);
  }

  return {
    repetition,
    intervalDays,
    efactor,
    dueAt: startOfDay(addDays(now, intervalDays)),
    lastReviewedAt: now,
    quality,
    lapsed,
  };
}

export interface DueCardLike {
  dueAt: Date;
}

/** ¿La tarjeta vence hoy o antes? */
export function isCardDue(card: DueCardLike, now: Date = new Date()): boolean {
  return card.dueAt.getTime() <= startOfDay(now).getTime();
}

/** Días que faltan (0 = hoy, negativo = vencida). */
export function daysUntilCardDue(card: DueCardLike, now: Date = new Date()): number {
  return Math.round(
    (startOfDay(card.dueAt).getTime() - startOfDay(now).getTime()) / 86_400_000
  );
}

export function countDueCards(
  cards: DueCardLike[],
  now: Date = new Date()
): number {
  return cards.filter((card) => isCardDue(card, now)).length;
}

/** Texto corto para la interfaz: «Hoy», «Mañana», «En 6 días». */
export function nextReviewLabel(dueAt: Date, now: Date = new Date()): string {
  const days = Math.round(
    (startOfDay(dueAt).getTime() - startOfDay(now).getTime()) / 86_400_000
  );
  if (days <= 0) return 'Hoy';
  if (days === 1) return 'Mañana';
  return `En ${days} días`;
}
