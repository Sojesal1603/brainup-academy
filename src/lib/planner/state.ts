import { db } from '../db';

/**
 * Estado del plan diario.
 *
 * `invalidatePlan` no reconstruye nada: solo marca el plan como invalidado y
 * guarda el motivo. La próxima apertura del Cuartel lo reconstruye con
 * `ensureTodayPlan`, que respeta lo ya empezado, hecho o abandonado. Así una
 * sesión, un examen o una sincronización no disparan una cascada de cálculos.
 */

/** Clave YYYY-MM-DD en la zona del alumno (nunca la del servidor). */
export function dayKeyInZone(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
}

/** Medianoche UTC del día local, que es lo que guarda `PlanState.day`. */
export function planDayFromKey(dayKey: string): Date {
  const [year, month, day] = dayKey.split('-').map((part) => Number(part));
  return new Date(Date.UTC(year, month - 1, day));
}

async function planDayFor(userId: string, now: Date): Promise<Date> {
  const profile = await db(userId).userProfile.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });
  const timezone = profile?.timezone || 'Europe/Madrid';
  return planDayFromKey(dayKeyInZone(now, timezone));
}

/**
 * Marca el plan de hoy como invalidado. Idempotente por naturaleza: si se llama
 * dos veces por el mismo motivo, la segunda solo actualiza la fecha y el
 * contador de versión, no crea otro plan.
 */
/**
 * Energía declarada por el alumno para hoy: 0.5 baja, 1 normal, 1.2 alta.
 * Se guarda en `PlanState` y la reconstrucción la usa en vez de la hora del reloj.
 */
export type PlanEnergy = 0.5 | 1 | 1.2;

export async function setPlanEnergy(
  userId: string,
  energy: PlanEnergy,
  now: Date = new Date()
): Promise<void> {
  const planDay = await planDayFor(userId, now);
  const factor = energy === 0.5 || energy === 1.2 ? energy : 1;

  await db(userId).planState.upsert({
    where: { userId_day: { userId, day: planDay } },
    create: {
      userId,
      day: planDay,
      status: 'invalidated',
      energy: factor,
      invalidatedAt: now,
      invalidationReason: 'energía elegida',
    },
    update: {
      energy: factor,
      status: 'invalidated',
      invalidatedAt: now,
      invalidationReason: 'energía elegida',
      version: { increment: 1 },
    },
  });
}

export async function invalidatePlan(
  userId: string,
  reason: string,
  now: Date = new Date()
): Promise<void> {
  const planDay = await planDayFor(userId, now);
  const cleanReason = String(reason ?? '').trim().slice(0, 200) || 'sin motivo';

  await db(userId).planState.upsert({
    where: { userId_day: { userId, day: planDay } },
    create: {
      userId,
      day: planDay,
      status: 'invalidated',
      invalidatedAt: now,
      invalidationReason: cleanReason,
    },
    update: {
      status: 'invalidated',
      invalidatedAt: now,
      invalidationReason: cleanReason,
      version: { increment: 1 },
    },
  });
}
