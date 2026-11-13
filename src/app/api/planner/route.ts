import { NextResponse } from 'next/server';
import { StudyMode } from '@/lib/types';
import { ensureTodayPlan, replanToday, reviewDayProgress } from '@/lib/dayPlan';
import { currentTenant } from '@/lib/tenantContext';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface ReplanBody {
  availableMinutes?: unknown;
  mode?: unknown;
}

/** Convierte el plan persistido en la vista que pinta el cliente. */
function planView(plan: Awaited<ReturnType<typeof ensureTodayPlan>>) {
  // Las abandonadas ya no son plan: no se pintan como si quedara trabajo.
  return plan.sessions
    .filter((session) => session.status !== 'abandonada')
    .map((session) => ({
    id: session.id,
    asignatura: session.subjectName,
    tema: session.topicTitle,
    unidad: session.unitNumber,
    color: session.subjectColor,
    objetivo: session.objective,
    duracionMinutos: session.durationMinutes,
    descansoMinutos: session.breakMinutes,
    tipoActividad: session.technique,
    fase: session.stage,
    motivo: session.reason,
    estado: session.status,
    completada: session.isCompleted,
    minutosHechos: session.spentMinutes,
      dominio: session.mastery,
      fuenteDominio: session.masterySource,
    }));
}

/**
 * Estado actual del planificador: la revisión del día y el plan guardado.
 * No escribe nada; sirve para que el cliente pueda refrescar sin recalcular.
 */
export async function GET() {
  try {
    // En serie a propósito: `ensureTodayPlan` puede escribir el plan y SQLite
    // no permite leer mientras se escribe. Lanzarlas en paralelo hacía que la
    // lectura esperara al bloqueo y la petición pareciera colgada.
    const { user } = await currentTenant();
    const plan = await ensureTodayPlan(user.id);
    const review = await reviewDayProgress(user.id);
    return NextResponse.json(
      {
        ok: true,
        headline: plan.headline,
        availableMinutes: plan.availableMinutes,
        plannedMinutes: plan.plannedMinutes,
        review,
        plan: planView(plan),
        generatedAt: plan.generatedAtIso,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('[planner] no se pudo leer el plan:', error);
    return NextResponse.json(
      { ok: false, error: 'No se ha podido leer el plan de hoy.' },
      { status: 500 }
    );
  }
}

/**
 * «Actualizar Plan de Hoy».
 *
 * Cuerpo: { availableMinutes?: number, mode?: 'comfort' | 'athlete' }
 *
 * El motor revisa lo completado, lo que está a medias y lo retrasado; descuenta
 * del presupuesto lo ya trabajado; y vuelve a repartir el tiempo que queda entre
 * los exámenes y el temario activos. Lo completado no se toca nunca.
 */
export async function POST(request: Request) {
  let body: ReplanBody = {};
  try {
    body = (await request.json()) as ReplanBody;
  } catch {
    // Sin cuerpo también vale: se recalcula con el tiempo real del día.
  }

  const rawMinutes = Number(body.availableMinutes);
  const budgetMinutes =
    Number.isFinite(rawMinutes) && rawMinutes > 0
      ? Math.min(600, Math.max(10, Math.round(rawMinutes)))
      : undefined;

  const mode: StudyMode | undefined =
    body.mode === 'comfort' || body.mode === 'athlete' ? body.mode : undefined;

  try {
    const { user } = await currentTenant();
    const result = await replanToday(user.id, { budgetMinutes, mode });
    const active = result.plan.sessions.filter(
      (session) => !session.isCompleted && session.status !== 'abandonada'
    );

    return NextResponse.json(
      {
        ok: true,
        headline: result.plan.headline,
        reason:
          result.reason ??
          `${active.length} sesión(es) para lo que queda de hoy.`,
        availableMinutes: result.availableMinutes,
        plannedMinutes: result.plan.plannedMinutes,
        created: result.created,
        carried: result.carried,
        abandoned: result.abandoned,
        review: result.review,
        plan: planView(result.plan),
        generatedAt: result.plan.generatedAtIso,
        // El plan lo calcula el motor de sesiones con datos reales de Prisma.
        // No lo redacta un modelo: un LLM no debe escribir en la agenda.
        usedAI: false,
        planner: 'sessionEngine',
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('[planner] no se pudo actualizar el plan:', error);
    return NextResponse.json(
      {
        ok: false,
        error: 'No se ha podido actualizar el plan. Revisa la consola del servidor.',
      },
      { status: 500 }
    );
  }
}
