/**
 * Motor puro del planificador.
 *
 * No toca la base de datos, no llama a ningún modelo y no lee la hora del
 * sistema: todo lo que necesita entra por `PlanContext`. Así el plan del día es
 * reproducible y se puede probar sin arrancar Next ni Prisma.
 */

const DAY_MS = 86_400_000;
const MAX_PER_SUBJECT = 2;
const MIN_BLOCKS = 3;
const MAX_BLOCKS = 5;

export type EnergyLevel = 0.5 | 1 | 1.2;

export interface PlanCandidate {
  key: string;
  topicId: string;
  subjectId: string;
  title: string;
  subjectName: string;
  minutes: number;
  /** 0..1: cuánto urge trabajarlo según el expediente. */
  priority: number;
  deadline?: Date | null;
  /** 0..1: dominio medido (1 = dominado). */
  mastery: number;
  /** 0..5. */
  difficulty: number;
  kind: 'repaso' | 'nuevo' | 'examen' | 'error' | 'clase';
}

export interface PlanContext {
  now: Date;
  timezone: string;
  energy: EnergyLevel;
  /** 70 % del tiempo disponible, ya calculado por el orquestador. */
  capacityMin: number;
  /** 10–15 minutos. */
  minBlockMin: number;
  /** 3–5 bloques. */
  maxBlocks: number;
}

/** Capacidad del plan: 70 % del tiempo disponible, redondeado hacia abajo. */
export function capacityFor(availableMinutes: number): number {
  if (!Number.isFinite(availableMinutes) || availableMinutes <= 0) return 0;
  return Math.floor(availableMinutes * 0.7);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Número de día en la zona del alumno, para no depender del reloj del servidor. */
function dayNumber(date: Date, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    const year = get('year');
    const month = get('month');
    const day = get('day');
    if (!year || !month || !day) throw new Error('fecha incompleta');
    return Math.round(Date.UTC(year, month - 1, day) / DAY_MS);
  } catch {
    return Math.round(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / DAY_MS
    );
  }
}

function daysUntil(deadline: Date | null | undefined, context: PlanContext): number | null {
  if (!deadline) return null;
  return dayNumber(deadline, context.timezone) - dayNumber(context.now, context.timezone);
}

function urgency(deadline: Date | null | undefined, context: PlanContext): number {
  const days = daysUntil(deadline, context);
  if (days === null) return 0;
  if (days <= 0) return 1;
  if (days <= 2) return 1;
  if (days <= 7) return 0.8;
  if (days <= 14) return 0.5;
  return 0.2;
}

/** Cuánto encaja el tipo de bloque con la energía elegida. */
function energyFit(candidate: PlanCandidate, energy: EnergyLevel): number {
  if (energy === 1.2) {
    if (candidate.kind === 'nuevo' || candidate.kind === 'examen') return 0.1;
    if (candidate.kind === 'repaso') return -0.05;
  }
  if (energy === 0.5) {
    if (candidate.kind === 'repaso' || candidate.kind === 'error') return 0.1;
    if (candidate.kind === 'nuevo' || candidate.kind === 'examen') return -0.15;
  }
  return 0;
}

/**
 * Puntuación 0..1. La prioridad manda; después el dominio bajo, la cercanía de
 * la fecha y la dificultad. Un examen a dos días adelanta a una unidad nueva.
 */
export function score(candidate: PlanCandidate, context: PlanContext): number {
  const base =
    0.45 * clamp(candidate.priority, 0, 1) +
    0.25 * (1 - clamp(candidate.mastery, 0, 1)) +
    0.2 * urgency(candidate.deadline, context) +
    0.1 * (clamp(candidate.difficulty, 0, 5) / 5);

  let bonus = energyFit(candidate, context.energy);
  const days = daysUntil(candidate.deadline, context);
  if (days !== null && days <= 2) {
    if (candidate.kind === 'examen') bonus += 0.15;
    if (candidate.kind === 'nuevo') bonus -= 0.2;
  }

  return clamp(base + bonus, 0, 1);
}

function normalizedLimits(context: PlanContext): { minBlock: number; maxBlocks: number } {
  return {
    minBlock: clamp(Math.round(context.minBlockMin), 10, 15),
    maxBlocks: clamp(Math.round(context.maxBlocks), MIN_BLOCKS, MAX_BLOCKS),
  };
}

function byScoreThenKey(context: PlanContext) {
  return (a: PlanCandidate, b: PlanCandidate) => {
    const diff = score(b, context) - score(a, context);
    return diff !== 0 ? diff : a.key.localeCompare(b.key);
  };
}

/**
 * Elige entre 3 y 5 bloques sin pasarse de la capacidad ni de dos por materia.
 * Si no hay suficientes candidatos válidos devuelve los que haya: nunca inventa
 * bloques ni minutos.
 */
export function pickBlocks(candidates: PlanCandidate[], context: PlanContext): PlanCandidate[] {
  const { minBlock, maxBlocks } = normalizedLimits(context);
  const capacity = Math.max(0, context.capacityMin);

  const valid = candidates
    .filter((candidate) => candidate.minutes >= minBlock && candidate.minutes > 0)
    .slice()
    .sort(byScoreThenKey(context));

  const picked: PlanCandidate[] = [];
  const perSubject = new Map<string, number>();
  let used = 0;

  for (const candidate of valid) {
    if (picked.length >= maxBlocks) break;
    if (used + candidate.minutes > capacity) continue;
    const count = perSubject.get(candidate.subjectId) ?? 0;
    if (count >= MAX_PER_SUBJECT) continue;
    picked.push(candidate);
    perSubject.set(candidate.subjectId, count + 1);
    used += candidate.minutes;
  }

  return picked;
}

/**
 * Evita dos bloques seguidos de la misma materia cuando hay alternativa. Es un
 * reordenado estable: no cambia qué bloques entran, solo el orden.
 */
export function interleave(blocks: PlanCandidate[]): PlanCandidate[] {
  const pending = blocks.slice();
  const result: PlanCandidate[] = [];

  while (pending.length > 0) {
    const previous = result[result.length - 1];
    let index = pending.findIndex((block) => block.subjectId !== previous?.subjectId);
    if (index < 0) index = 0;
    result.push(pending.splice(index, 1)[0]);
  }

  return result;
}
