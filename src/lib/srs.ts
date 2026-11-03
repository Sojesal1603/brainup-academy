/**
 * Repaso Espaciado (SRS) con analítica de retención.
 *
 * El planificador ya colocaba bloques «Repaso Espaciado», pero nadie llevaba la
 * cuenta de *cuándo* toca repasar cada unidad ni de *si se está recordando*. Este
 * módulo es el motor que faltaba, y hace tres cosas:
 *
 *   1. **Programa el siguiente repaso** a partir de cómo ha ido el de hoy. Es un
 *      SM-2 simplificado: el intervalo crece si lo recuerdas y vuelve a empezar
 *      si no; el factor de facilidad (`easeFactor`) sube o baja según lo cuesta
 *      cada unidad. Un repaso, un intervalo nuevo, y a la vista de todos.
 *   2. **Estima la retención de cada unidad hoy**: cuánto queda de aquello antes
 *      de que se te olvide. Es una estimación *declarada como estimación*, con la
 *      curva del olvido y la facilidad de la unidad; se llama retención y no
 *      «dominio» porque no es lo mismo saber algo que acordarse de ello.
 *   3. **Mide la retención de verdad**, con los repasos que ya has hecho: cuántos
 *      has recordado y cuántos no, agrupados por el intervalo que llevabas. Eso
 *      es lo único honesto: sin historial propio solo hay estimaciones.
 *
 * Módulo puro (sin Prisma ni red) para poder probarlo de forma aislada.
 */

/* ------------------------------------------------------------------ */
/* 1. Cómo ha ido el repaso                                             */
/* ------------------------------------------------------------------ */

export type SrsRating = 'again' | 'hard' | 'good' | 'easy';

export const SRS_RATINGS: Record<
  SrsRating,
  {
    label: string;
    short: string;
    /** Valor interno del algoritmo (0-5, el clásico de SuperMemo). */
    quality: number;
    description: string;
    /** ¿Se considera que lo recordaba? `again` no. */
    recalled: boolean;
    badgeColor: string;
    buttonClass: string;
  }
> = {
  again: {
    label: 'No me acordaba',
    short: 'Otra vez',
    quality: 0,
    description: 'Se ha olvidado: la unidad vuelve mañana y el intervalo empieza de cero',
    recalled: false,
    badgeColor: 'bg-rose-500/10 text-rose-400 border-rose-500/30',
    buttonClass: 'border-rose-500/40 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20',
  },
  hard: {
    label: 'Con esfuerzo',
    short: 'Difícil',
    quality: 3,
    description: 'Lo he sacado, pero me ha costado: el intervalo sube poco',
    recalled: true,
    badgeColor: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
    buttonClass: 'border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20',
  },
  good: {
    label: 'Lo tenía',
    short: 'Bien',
    quality: 4,
    description: 'Recordado sin problema: el intervalo crece de forma normal',
    recalled: true,
    badgeColor: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
    buttonClass: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20',
  },
  easy: {
    label: 'Me sobraba',
    short: 'Fácil',
    quality: 5,
    description: 'Trivial: el intervalo se estira aún más',
    recalled: true,
    badgeColor: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30',
    buttonClass: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20',
  },
};

export const SRS_RATING_ORDER: SrsRating[] = ['again', 'hard', 'good', 'easy'];

export function isSrsRating(value: unknown): value is SrsRating {
  return typeof value === 'string' && (SRS_RATING_ORDER as string[]).includes(value);
}

/** Límites del factor de facilidad (los mismos que usa SuperMemo). */
export const SRS_MIN_EASE = 1.3;
export const SRS_MAX_EASE = 2.8;

/** Tope de intervalo: más allá de medio año, repasar ya no es rentable. */
export const SRS_MAX_INTERVAL_DAYS = 180;

/** A partir de este intervalo la unidad se considera cerrada («repasado»). */
export const SRS_MASTERED_INTERVAL_DAYS = 21;

/** Días del primer repaso según cómo haya ido (antes de tener historial). */
const FIRST_INTERVAL: Record<SrsRating, number> = { again: 1, hard: 1, good: 2, easy: 4 };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Medianoche local: el SRS razona en días, no en milisegundos. */
export function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

/* ------------------------------------------------------------------ */
/* 2. La programación: cuándo toca el próximo repaso                    */
/* ------------------------------------------------------------------ */

export interface SrsState {
  /** Intervalo programado actual, en días. */
  intervalDays: number;
  /** Factor de facilidad (2.5 por defecto; menos = te cuesta más). */
  easeFactor: number;
  /** Último repaso hecho. `null` = nunca se ha repasado. */
  lastReviewedAt: Date | null;
}

export interface SrsNextState {
  intervalDays: number;
  easeFactor: number;
  /** Fecha del próximo repaso (a medianoche del día que toca). */
  nextReviewAt: Date;
}

/**
 * El corazón del SM-2, sin adornos: aplicar un repaso y devolver el estado
 * siguiente. Las reglas son las de siempre y están aquí a la vista para poder
 * discutirlas:
 *
 *   - `again` → vuelve a mañana y el intervalo se reinicia (lo has olvidado).
 *   - `hard`  → el intervalo sube un 20% (mínimo un día).
 *   - `good`  → el intervalo se multiplica por el factor de facilidad.
 *   - `easy`  → además se estira un 30% extra.
 *   - El factor de facilidad sube cuando te sobra y baja cuando te cuesta,
 *     entre 1.3 y 2.8.
 */
export function applySrsReview(
  state: SrsState,
  rating: SrsRating,
  now: Date = new Date()
): SrsNextState {
  const meta = SRS_RATINGS[rating];
  const quality = meta.quality;
  const intervalBefore = state.lastReviewedAt ? Math.max(0, state.intervalDays) : 0;

  // Fórmula clásica de SuperMemo para el factor de facilidad.
  const rawEase = state.easeFactor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
  const easeFactor = clamp(
    Number.isFinite(rawEase) ? rawEase : 2.5,
    SRS_MIN_EASE,
    SRS_MAX_EASE
  );

  let intervalDays: number;
  if (rating === 'again') {
    intervalDays = FIRST_INTERVAL.again;
  } else if (intervalBefore <= 0) {
    intervalDays = FIRST_INTERVAL[rating];
  } else if (rating === 'hard') {
    intervalDays = Math.max(1, Math.round(intervalBefore * 1.2));
  } else if (rating === 'easy') {
    intervalDays = Math.max(1, Math.round(intervalBefore * easeFactor * 1.3));
  } else {
    intervalDays = Math.max(1, Math.round(intervalBefore * easeFactor));
  }

  intervalDays = clamp(intervalDays, 1, SRS_MAX_INTERVAL_DAYS);

  return {
    intervalDays,
    easeFactor: Math.round(easeFactor * 100) / 100,
    nextReviewAt: startOfDay(addDays(now, intervalDays)),
  };
}

/** Cómo queda la unidad en el temario: cerrada cuando el intervalo ya es largo. */
export function isMasteredInterval(intervalDays: number): boolean {
  return intervalDays >= SRS_MASTERED_INTERVAL_DAYS;
}

/** Estado SRS de una unidad tal como vive en la base de datos. */
export interface SrsTopicLike {
  lastReviewedAt: Date | null;
  srsIntervalDays: number;
  srsEaseFactor: number;
}

/** Fecha del próximo repaso, o `null` si nunca se ha repasado. */
export function nextReviewAt(topic: SrsTopicLike): Date | null {
  if (!topic.lastReviewedAt) return null;
  return startOfDay(addDays(startOfDay(topic.lastReviewedAt), Math.max(1, topic.srsIntervalDays)));
}

/** Días que faltan para el repaso (0 = hoy, negativo = vencido). `null` si no hay historial. */
export function daysUntilReview(topic: SrsTopicLike, now: Date = new Date()): number | null {
  const next = nextReviewAt(topic);
  if (!next) return null;
  return Math.round((next.getTime() - startOfDay(now).getTime()) / 86400000);
}

/** Días de retraso sobre la fecha prevista (0 si aún no toca). */
export function overdueDays(topic: SrsTopicLike, now: Date = new Date()): number {
  const days = daysUntilReview(topic, now);
  if (days === null) return 0;
  return Math.max(0, -days);
}

/** ¿Toca repasarlo hoy o antes? */
export function isDue(topic: SrsTopicLike, now: Date = new Date()): boolean {
  const days = daysUntilReview(topic, now);
  return days !== null && days <= 0;
}

/* ------------------------------------------------------------------ */
/* 3. Retención estimada (la curva del olvido)                          */
/* ------------------------------------------------------------------ */

/**
 * Retención estimada de una unidad ahora mismo, en porcentaje (0-100).
 *
 * Se usa la curva del olvido (Ebbinghaus): `R = e^(-t/S)`, donde `t` son los días
 * desde el último repaso y `S` la estabilidad de ese recuerdo. La estabilidad se
 * deriva del propio intervalo programado —un intervalo de N días se elige
 * precisamente porque a los N días se recuerda más o menos un 90%— y se ajusta
 * por el factor de facilidad: la misma unidad con facilidad 1.3 se olvida antes
 * que con 2.8.
 *
 * Es una ESTIMACIÓN, y se presenta como tal. Lo que de verdad se ha recordado
 * está en los repasos hechos (`buildRetentionAnalytics`).
 *
 * Devuelve `null` si la unidad nunca se ha repasado: sin un repaso previo no hay
 * nada que estimar, y 0% sería una mentira.
 */
export function estimateRetention(topic: SrsTopicLike, now: Date = new Date()): number | null {
  if (!topic.lastReviewedAt) return null;

  const intervalDays = Math.max(1, topic.srsIntervalDays);
  const ease = clamp(topic.srsEaseFactor || 2.5, SRS_MIN_EASE, SRS_MAX_EASE);

  // Estabilidad: un intervalo de I días con facilidad 2.5 se corresponde con un
  // recuerdo que decae hasta el 90% justo al llegar a I días.
  const baseStabilityDays = intervalDays * 9.49;
  const stabilityDays = baseStabilityDays * (ease / 2.5);

  const elapsedDays = Math.max(
    0,
    (startOfDay(now).getTime() - startOfDay(topic.lastReviewedAt).getTime()) / 86400000
  );

  const retention = Math.exp(-elapsedDays / Math.max(0.5, stabilityDays)) * 100;
  return Math.round(clamp(retention, 0, 100));
}

export interface RetentionTone {
  label: string;
  className: string;
}

/** Cómo llamar a una retención sin exagerar: ni «dominado» ni «perdido». */
export function retentionTone(retention: number | null): RetentionTone {
  if (retention === null) return { label: 'Sin repasar', className: 'text-slate-500' };
  if (retention >= 85) return { label: 'Fresco', className: 'text-emerald-400' };
  if (retention >= 65) return { label: 'A tiempo', className: 'text-sky-400' };
  if (retention >= 45) return { label: 'Enfriándose', className: 'text-amber-400' };
  return { label: 'En riesgo', className: 'text-rose-400' };
}

/* ------------------------------------------------------------------ */
/* 4. La cola del día: qué toca repasar                                 */
/* ------------------------------------------------------------------ */

export interface ReviewQueueItem<T> {
  topic: T;
  /** Toca hoy o está vencido. */
  due: boolean;
  /** Días hasta el repaso (negativo = vencido). */
  daysUntil: number;
  overdue: number;
  /** Retención estimada ahora (0-100). */
  retention: number | null;
  /** Orden dentro de la cola: más alto = antes. */
  score: number;
}

/**
 * Cola de repaso de hoy, ordenada por urgencia: primero lo más vencido y lo que
 * peor se recuerda. Solo entran unidades con historial de repaso (las que nunca
 * se han repasado no tienen calendario; esas se proponen como primera pasada
 * desde el planificador).
 */
export function buildReviewQueue<T extends SrsTopicLike>(
  topics: T[],
  now: Date = new Date(),
  /** Solo las unidades vencidas o de hoy (para «Repasos de hoy» del Cuartel). */
  options: { onlyDue?: boolean } = {}
): ReviewQueueItem<T>[] {
  const items: ReviewQueueItem<T>[] = [];

  for (const topic of topics) {
    const daysUntil = daysUntilReview(topic, now);
    if (daysUntil === null) continue;

    const overdue = Math.max(0, -daysUntil);
    const retention = estimateRetention(topic, now);
    const due = daysUntil <= 0;

    if (options.onlyDue && !due) continue;

    items.push({
      topic,
      due,
      daysUntil,
      overdue,
      retention,
      // Lo vencido manda; entre lo vencido, lo que peor se recuerda.
      score: overdue * 10 + (100 - (retention ?? 50)) + (due ? 15 : 0),
    });
  }

  items.sort((a, b) => b.score - a.score);
  return items;
}

/* ------------------------------------------------------------------ */
/* 5. Analítica de retención: lo que de verdad has recordado            */
/* ------------------------------------------------------------------ */

/** Un repaso ya hecho, tal como se guarda en la base de datos. */
export interface SrsReviewRow {
  reviewedAt: Date;
  rating: string;
  quality: number;
  recalled: boolean;
  intervalBeforeDays: number;
  intervalAfterDays: number;
  /** Factor de facilidad que queda tras el repaso (ver `applySrsReview`). */
  easeAfter: number;
  overdueDays: number;
}

export interface RetentionBucket {
  key: string;
  label: string;
  /** Intervalo mínimo (días) que cubre el tramo. */
  minDays: number;
  maxDays: number;
  reviews: number;
  recalled: number;
  /** Porcentaje de repasos recordados en este tramo (`null` si no hay datos). */
  recallRate: number | null;
}

/** Tramos de intervalo: es donde se ve si estiras demasiado los repasos. */
const BUCKET_DEFS: Array<{ key: string; label: string; minDays: number; maxDays: number }> = [
  { key: 'd1', label: '1 día', minDays: 0, maxDays: 1 },
  { key: 'd2a3', label: '2-3 días', minDays: 2, maxDays: 3 },
  { key: 'd4a7', label: '4-7 días', minDays: 4, maxDays: 7 },
  { key: 'd8a14', label: '1-2 semanas', minDays: 8, maxDays: 14 },
  { key: 'd15a30', label: '2-4 semanas', minDays: 15, maxDays: 30 },
  { key: 'd31', label: 'Más de un mes', minDays: 31, maxDays: Number.MAX_SAFE_INTEGER },
];

/**
 * Tasa de recuerdo por tramo de intervalo. Es el dato que dice si el calendario
 * está bien calibrado: si en «2-4 semanas» recuerdas poco, ese salto es
 * demasiado largo para ti.
 */
export function retentionBuckets(reviews: SrsReviewRow[]): RetentionBucket[] {
  return BUCKET_DEFS.map((def) => {
    const inBucket = reviews.filter((review) => {
      const interval = Math.max(
        0,
        review.intervalBeforeDays > 0 ? review.intervalBeforeDays : review.intervalAfterDays
      );
      return interval >= def.minDays && interval <= def.maxDays;
    });
    const recalled = inBucket.filter((review) => review.recalled).length;

    return {
      key: def.key,
      label: def.label,
      minDays: def.minDays,
      maxDays: def.maxDays,
      reviews: inBucket.length,
      recalled,
      recallRate: inBucket.length > 0 ? Math.round((recalled / inBucket.length) * 100) : null,
    };
  });
}

export interface ReviewActivityDay {
  /** «2026-10-13» */
  date: string;
  label: string;
  reviews: number;
  recalled: number;
}

/** Repasos por día (para ver si esto se sostiene o se abandona a los tres días). */
export function reviewActivity(
  reviews: SrsReviewRow[],
  days = 14,
  now: Date = new Date()
): ReviewActivityDay[] {
  const out: ReviewActivityDay[] = [];

  for (let offset = days - 1; offset >= 0; offset--) {
    const day = startOfDay(addDays(now, -offset));
    const next = startOfDay(addDays(day, 1));
    const inDay = reviews.filter((review) => {
      const at = new Date(review.reviewedAt).getTime();
      return at >= day.getTime() && at < next.getTime();
    });

    out.push({
      date: day.toISOString().slice(0, 10),
      label: day.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' }),
      reviews: inDay.length,
      recalled: inDay.filter((review) => review.recalled).length,
    });
  }

  return out;
}

export interface RetentionAnalytics {
  totalReviews: number;
  /** Porcentaje de repasos recordados (el número que importa). */
  recallRate: number | null;
  /** Repasos recordados sobre el total. */
  recalled: number;
  /** Facilidad media conseguida: menos de 2.2 es que te cuesta retener. */
  avgEaseAfter: number | null;
  avgIntervalDays: number | null;
  byRating: Record<SrsRating, number>;
  buckets: RetentionBucket[];
  activity: ReviewActivityDay[];
  reviewsThisWeek: number;
  /** Lectura honesta del estado, en una frase. */
  summary: string;
  /** ¿Hay algún repaso registrado? Sin ellos solo hay estimaciones. */
  hasData: boolean;
}

function isoWeekStart(now: Date): Date {
  const day = startOfDay(now);
  const weekday = (day.getDay() + 6) % 7; // 0 = lunes
  return startOfDay(addDays(day, -weekday));
}

/**
 * Analítica de retención a partir de los repasos REGISTRADOS. Si no hay
 * ninguno, lo dice (`hasData: false`) en vez de enseñar un gráfico vacío como si
 * fuera un resultado.
 */
export function buildRetentionAnalytics(
  reviews: SrsReviewRow[],
  now: Date = new Date()
): RetentionAnalytics {
  const rows = [...reviews].sort(
    (a, b) => new Date(a.reviewedAt).getTime() - new Date(b.reviewedAt).getTime()
  );

  const recalled = rows.filter((review) => review.recalled).length;
  const recallRate = rows.length > 0 ? Math.round((recalled / rows.length) * 100) : null;

  const easedRows = rows.filter((review) => Number.isFinite(review.easeAfter) && review.easeAfter > 0);
  const avgEaseAfter =
    easedRows.length > 0
      ? Math.round((easedRows.reduce((acc, review) => acc + review.easeAfter, 0) / easedRows.length) * 100) /
        100
      : null;

  const byRating: Record<SrsRating, number> = { again: 0, hard: 0, good: 0, easy: 0 };
  for (const review of rows) {
    if (isSrsRating(review.rating)) byRating[review.rating] += 1;
  }

  const avgIntervalDays =
    rows.length > 0
      ? Math.round(
          (rows.reduce((acc, review) => acc + Math.max(0, review.intervalBeforeDays), 0) / rows.length) * 10
        ) / 10
      : null;

  const weekStart = isoWeekStart(now);
  const reviewsThisWeek = rows.filter(
    (review) => new Date(review.reviewedAt).getTime() >= weekStart.getTime()
  ).length;

  let summary: string;
  if (rows.length === 0) {
    summary =
      'Todavía no hay ningún repaso registrado: el calendario está calculado, pero la retención real solo se sabe cuando repases.';
  } else if (recallRate !== null && recallRate >= 85) {
    summary = `Retienes bien: ${recallRate}% de los repasos los tenías. Puedes seguir alargando intervalos.`;
  } else if (recallRate !== null && recallRate >= 70) {
    summary = `Retención normal (${recallRate}%): el calendario está razonablemente ajustado a ti.`;
  } else {
    summary = `Retención baja (${recallRate}%): los intervalos te están quedando largos. Los repasos fallados vuelven a un día y el calendario se reajusta solo.`;
  }

  return {
    totalReviews: rows.length,
    recallRate,
    recalled,
    avgEaseAfter,
    avgIntervalDays,
    byRating,
    buckets: retentionBuckets(rows),
    activity: reviewActivity(rows, 14, now),
    reviewsThisWeek,
    summary,
    hasData: rows.length > 0,
  };
}

/**
 * Empujón de prioridad para el planificador: lo vencido sube, y cuanto más
 * vencido y peor recordado, más. Se mantiene acotado para que un repaso no
 * aplaste a un examen de mañana.
 */
export function srsPriorityBonus(topic: SrsTopicLike, now: Date = new Date()): number {
  const days = daysUntilReview(topic, now);
  if (days === null) return 0;
  if (days > 3) return 0;

  const overdue = Math.max(0, -days);
  const retention = estimateRetention(topic, now) ?? 60;
  const urgency = clamp(overdue, 0, 6) * 4 + clamp(70 - retention, 0, 45) * 0.25;
  return Math.round(clamp(urgency, 0, 26));
}
