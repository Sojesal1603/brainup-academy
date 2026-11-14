import { db } from '../db';
import { dayKeyInZone, planDayFromKey } from './state';
import { planConstraintSchema, type PlanConstraintInput } from './constraints';

export interface TodayConstraints {
  planId: string | null;
  constraints: PlanConstraintInput[];
}

export function parseStoredConstraints(rows: Array<{ payload: unknown }>): PlanConstraintInput[] {
  const constraints: PlanConstraintInput[] = [];
  for (const row of rows) {
    const parsed = planConstraintSchema.safeParse(row.payload);
    // Una fila vieja o corrupta se ignora; no se inventa una restricción.
    if (parsed.success) constraints.push(parsed.data);
  }
  return constraints;
}

/** Restricciones confirmadas para el plan de hoy (vacío si no hay). */
export async function readTodayPlanConstraints(
  userId: string,
  now: Date = new Date()
): Promise<TodayConstraints> {
  const prisma = db(userId);
  const profile = await prisma.userProfile.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });
  const timezone = profile?.timezone || 'Europe/Madrid';
  const planDay = planDayFromKey(dayKeyInZone(now, timezone));

  const state = await prisma.planState.findUnique({
    where: { userId_day: { userId, day: planDay } },
    select: {
      id: true,
      constraints: { select: { payload: true }, orderBy: { createdAt: 'asc' } },
    },
  });

  return {
    planId: state?.id ?? null,
    constraints: parseStoredConstraints(state?.constraints ?? []),
  };
}
