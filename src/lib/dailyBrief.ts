import { unstable_cache } from 'next/cache';
import { db } from './db';
import { ensureTodayPlan, type DayPlan } from './dayPlan';
import {
  buildDailyBrief,
  dailyBriefBucket,
  DAILY_BRIEF_BUCKET_MS,
  type DailyBrief,
  type DailyBriefNextExam,
} from './dailyBriefContract';
import { PLAN_CACHE_TAGS } from './planCache';
import { dayKeyInZone } from './planner/state';
import { getCachedProfileSummary } from './userProfile';

const DAY_MS = 86_400_000;

export type DailyBriefSnapshot = DailyBrief & {
  /**
   * El plan completo que produjo el brief. Va dentro de la misma foto para que
   * el Cuartel pinte «Hoy toca esto» con los mismos bloques que el resumen: no
   * hay una segunda consulta que pueda contar otra cosa.
   */
  plan: DayPlan;
};

function daysUntil(examDate: Date, now: Date, timezone: string): number {
  // Días naturales en la zona del alumno: un examen hoy a las 18:00 es «hoy»,
  // no «mañana» porque aún queden nueve horas.
  const examDay = Date.parse(`${dayKeyInZone(examDate, timezone)}T00:00:00.000Z`);
  const today = Date.parse(`${dayKeyInZone(now, timezone)}T00:00:00.000Z`);
  return Math.max(0, Math.round((examDay - today) / DAY_MS));
}

async function buildSnapshot(
  userId: string,
  dayKey: string,
  timezone: string,
  bucket: number
): Promise<DailyBriefSnapshot> {
  const now = new Date(bucket * DAILY_BRIEF_BUCKET_MS);
  const plan = await ensureTodayPlan(userId, now);

  // Una sola lectura extra para el riesgo que el plan no expone. Si falla, el
  // brief sigue siendo útil: el examen es contexto, no el plan. La narración
  // vive en `AgentMemory` y la escribe el `after()` del director.
  const [exam, narrationMemory] = await Promise.all([
    db(userId)
      .exam.findFirst({
        where: { isCompleted: false, examDate: { gte: now } },
        orderBy: { examDate: 'asc' },
        select: {
          title: true,
          examDate: true,
          subject: { select: { name: true } },
        },
      })
      .catch(() => null),
    db(userId)
      .agentMemory.findUnique({
        where: { userId_scope_day: { userId, scope: 'director', day: dayKey } },
        select: { summary: true, writtenBy: true },
      })
      .catch(() => null),
  ]);

  const nextExam: DailyBriefNextExam | null = exam
    ? {
        title: exam.title,
        subjectName: exam.subject.name,
        days: daysUntil(exam.examDate, now, timezone),
      }
    : null;

  const brief = buildDailyBrief(plan, {
    generatedAtIso: now.toISOString(),
    nextExam,
  });

  return {
    ...brief,
    plan,
    narration: narrationMemory?.summary?.trim() || null,
    narrationStatus: narrationMemory ? 'ready' : 'pending',
  };
}

const loadDailyBrief = unstable_cache(buildSnapshot, ['daily-brief-v1'], {
  // El plan persistido manda; este TTL solo refresca la hora del día (minutos
  // disponibles) y el próximo examen. Los cambios de estado purgan la entrada
  // al instante vía `revalidatePlanCache`.
  revalidate: 60,
  tags: [...PLAN_CACHE_TAGS],
});

/**
 * Brief del día ya «masticado»: 1 cálculo por usuario y minuto, 0 llamadas a IA.
 *
 * La clave incluye el día local del alumno y un cubo de un minuto. Dos
 * navegaciones seguidas reutilizan exactamente la misma foto; al cambiar de
 * minuto se recalcula como mucho una vez, y cualquier evento que llame a
 * `invalidatePlan` la tira antes.
 */
export async function getDailyBrief(
  userId: string,
  now: Date = new Date()
): Promise<DailyBriefSnapshot> {
  const profile = await getCachedProfileSummary(userId).catch(() => null);
  const timezone = profile?.timezone || 'Europe/Madrid';
  const dayKey = dayKeyInZone(now, timezone);
  const bucket = dailyBriefBucket(now);
  return loadDailyBrief(userId, dayKey, timezone, bucket);
}
