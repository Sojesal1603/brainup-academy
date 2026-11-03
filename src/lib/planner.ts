import { prisma } from './prisma';
import { effectiveMastery } from './knowledge';
import { regenerateWeekPlan } from './dayPlan';
import { StudyMode } from './types';

/**
 * Horas que le faltan a una unidad para estar dominada.
 *
 * Es la cifra que se enseña en el planificador («horas requeridas»). El reparto
 * del día ya no sale de aquí: sale del motor de sesiones (`sessionEngine.ts`),
 * que trabaja por fases y con el tiempo real de cada día.
 *
 * Si el dominio no está medido se usa el valor neutro (`effectiveMastery`), no
 * un 0%: no sabemos si ese tema está flojo, así que no se le asignan las horas
 * de un tema que suspendes.
 */
export function calculateRequiredHoursForTopic(
  topic: { difficulty: number; masteryLevel: number; masterySource?: string | null },
  subjectTargetGrade: number
): number {
  const deficit = Math.max(0, (100 - effectiveMastery(topic)) / 100);
  const diffFactor = 1 + (topic.difficulty - 1) * 0.35;
  const targetFactor = subjectTargetGrade / 7.0;
  const hours = 4.0 + deficit * 12.0 * diffFactor * targetFactor;
  return Math.round(hours * 10) / 10;
}

/**
 * Recalcula el plan de los próximos siete días.
 *
 * Antes esto generaba bloques fijos de 45 minutos y repartía tus horas
 * semanales a ciegas. Ahora delega en `regenerateWeekPlan`, que para cada día:
 *
 *   - mira las clases que tiene (y a qué hora sale),
 *   - calcula el tiempo real disponible,
 *   - estima el trabajo que queda por fases,
 *   - y reparte **sesiones de 10 a 90 minutos** que caben exactamente.
 */
export async function regenerateWeeklyPlan(mode: StudyMode = 'athlete') {
  const result = await regenerateWeekPlan(mode);

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [planned, user] = await Promise.all([
    prisma.studyBlock.aggregate({
      where: { date: { gte: todayStart }, isCompleted: false },
      _sum: { durationMinutes: true },
    }),
    prisma.userProfile.findUnique({ where: { id: 'user_default' } }),
  ]);

  return {
    success: true,
    count: result.count,
    /** Presupuesto semanal que ha usado el plan (minutos). */
    weeklyMinutesBudget: Math.round((user?.weeklyHoursCap ?? 0) * 60),
    /** Minutos realmente planificados para los próximos 7 días. */
    plannedMinutes: planned._sum.durationMinutes ?? 0,
    /** ¿Las horas salen de lo que dijo el alumno o del valor de partida? */
    hoursDeclared: user?.weeklyHoursDeclared ?? false,
    /** Días generados y si las sesiones son de duración variable. */
    days: result.days,
    variableSessions: true,
  };
}
