import { NextResponse } from 'next/server';
import { prisma, withTransaction } from '@/lib/prisma';
import { ensureUserProfile } from '@/lib/userProfile';
import { reviewDayProgress } from '@/lib/dayPlan';
import {
  NIGHT_CLOSE_SCOPE,
  NIGHT_DELAY_SCOPE,
  NIGHT_MIN_JUSTIFICATION,
  NIGHT_PENALTY_POINTS,
  evaluateNightClose,
} from '@/lib/nightClose';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PENDING_STATUSES = ['pendiente', 'parcial', 'en_curso'];

function todayBounds(now: Date = new Date()): { start: Date; end: Date } {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

async function loadPending(userId: string, now: Date = new Date()) {
  const { start, end } = todayBounds(now);
  return prisma.studyBlock.findMany({
    where: {
      userId,
      date: { gte: start, lt: end },
      isCompleted: false,
      status: { in: PENDING_STATUSES },
    },
    include: { topic: { include: { subject: true } } },
    orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }],
  });
}

type PendingRow = Awaited<ReturnType<typeof loadPending>>[number];

function pendingView(rows: PendingRow[]) {
  return rows.map((row) => ({
    id: row.id,
    subject: row.topic.subject.name,
    subjectColor: row.topic.subject.color,
    topic: row.topic.title,
    minutes: row.durationMinutes,
    status: row.status,
    technique: row.technique,
  }));
}

/**
 * Estado del cierre nocturno: qué queda vivo, si el día está bloqueado y si ya
 * se cerró. La regla pura vive en `nightClose.ts`.
 */
export async function GET() {
  try {
    const user = await ensureUserProfile();
    const review = await reviewDayProgress();

    const [rows, closeMemory, delayMemory] = await Promise.all([
      loadPending(user.id),
      prisma.agentMemory.findUnique({
        where: {
          userId_scope_day: {
            userId: user.id,
            scope: NIGHT_CLOSE_SCOPE,
            day: review.dayKey,
          },
        },
      }),
      prisma.agentMemory.findUnique({
        where: {
          userId_scope_day: {
            userId: user.id,
            scope: NIGHT_DELAY_SCOPE,
            day: review.dayKey,
          },
        },
      }),
    ]);

    const state = evaluateNightClose(review, new Date(), Boolean(closeMemory));

    return NextResponse.json(
      {
        ok: true,
        state,
        closed: Boolean(closeMemory),
        closedAt: closeMemory?.updatedAt ?? null,
        lastDelay: delayMemory
          ? { summary: delayMemory.summary, at: delayMemory.updatedAt }
          : null,
        pending: pendingView(rows),
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('[planner/night] no se pudo leer el cierre:', error);
    return NextResponse.json(
      { error: 'No se ha podido leer el cierre del día.' },
      { status: 500 }
    );
  }
}

interface NightBody {
  action?: unknown;
  justification?: unknown;
}

/**
 * Cerrar o aplazar la jornada.
 *
 * - `cerrar` exige CERO tareas pendientes. Con algo vivo responde 409: el día
 *   no se cierra, igual que el Nightly Coach del sistema.
 * - `aplazar` exige una razón real (mínimo 20 caracteres) y escribe la
 *   penalización en la base de datos: cada bloque pendiente sube +25 de
 *   prioridad y queda registrado el motivo del aplazamiento.
 */
export async function POST(request: Request) {
  let body: NightBody = {};
  try {
    body = (await request.json()) as NightBody;
  } catch {
    // Sin cuerpo vale: se decide por lo que haya pendiente.
  }

  const action =
    body.action === 'cerrar' || body.action === 'aplazar' ? body.action : null;
  const justification =
    typeof body.justification === 'string' ? body.justification.trim() : '';

  try {
    const user = await ensureUserProfile();
    const review = await reviewDayProgress();
    const rows = await loadPending(user.id);

    if (action === 'cerrar') {
      if (rows.length > 0) {
        return NextResponse.json(
          {
            error: `No se cierra el día con ${rows.length} tarea(s) obligatorias pendientes. Termínalas o aplázalas con una razón; si las aplazas, vuelven con +${NIGHT_PENALTY_POINTS} de prioridad.`,
            state: evaluateNightClose(review),
            closed: false,
            pending: pendingView(rows),
          },
          { status: 409 }
        );
      }

      await prisma.agentMemory.upsert({
        where: {
          userId_scope_day: {
            userId: user.id,
            scope: NIGHT_CLOSE_SCOPE,
            day: review.dayKey,
          },
        },
        create: {
          userId: user.id,
          scope: NIGHT_CLOSE_SCOPE,
          day: review.dayKey,
          summary: `Día cerrado sin tareas obligatorias pendientes (${review.completedBlocks} bloque(s) completados, ${review.completedMinutes} min).`,
          factsJson: JSON.stringify({
            closed: true,
            completedBlocks: review.completedBlocks,
            completedMinutes: review.completedMinutes,
          }),
          writtenBy: 'reglas',
        },
        update: {
          summary: `Día cerrado sin tareas obligatorias pendientes (${review.completedBlocks} bloque(s) completados, ${review.completedMinutes} min).`,
          factsJson: JSON.stringify({
            closed: true,
            completedBlocks: review.completedBlocks,
            completedMinutes: review.completedMinutes,
          }),
          writtenBy: 'reglas',
        },
      });

      const state = evaluateNightClose(review, new Date(), true);
      return NextResponse.json({
        ok: true,
        closed: true,
        state,
        pending: [],
        message: state.message,
      });
    }

    if (rows.length === 0) {
      return NextResponse.json({
        ok: true,
        closed: false,
        state: evaluateNightClose(review),
        pending: [],
        message: 'No queda nada que aplazar: no hay tareas obligatorias pendientes.',
      });
    }

    if (justification.length < NIGHT_MIN_JUSTIFICATION) {
      return NextResponse.json(
        {
          error: `Para aplazar necesito una razón real (mínimo ${NIGHT_MIN_JUSTIFICATION} caracteres). «Me da pereza» no es una razón: dime qué pasa y cómo lo vas a recuperar.`,
          state: evaluateNightClose(review),
          closed: false,
          pending: pendingView(rows),
        },
        { status: 400 }
      );
    }

    const summary = `Aplazó ${rows.length} tarea(s) obligatoria(s) del día: ${justification}`.slice(
      0,
      900
    );

    const factsJson = JSON.stringify({
      closed: false,
      postponed: rows.length,
      penalty: NIGHT_PENALTY_POINTS,
      justification,
      pending: rows.map((row) => ({
        topic: row.topic.title,
        minutes: row.durationMinutes,
      })),
    });

    // Dentro de la transacción no hay reintentos de escritura ni cierres del
    // pool: o se aplican las dos cosas (prioridad + memoria) o no se aplica
    // ninguna. Antes era una transacción por lotes, que la extensión no podía
    // reconocer como «transacción abierta».
    await withTransaction(async (tx) => {
      await tx.studyBlock.updateMany({
        where: { userId: user.id, id: { in: rows.map((row) => row.id) } },
        data: {
          priorityScore: { increment: NIGHT_PENALTY_POINTS },
          origin: 'reprogramada',
        },
      });
      await tx.agentMemory.upsert({
        where: {
          userId_scope_day: {
            userId: user.id,
            scope: NIGHT_DELAY_SCOPE,
            day: review.dayKey,
          },
        },
        create: {
          userId: user.id,
          scope: NIGHT_DELAY_SCOPE,
          day: review.dayKey,
          summary,
          factsJson,
          writtenBy: 'reglas',
        },
        update: { summary, factsJson, writtenBy: 'reglas' },
      });
    });

    return NextResponse.json({
      ok: true,
      closed: false,
      state: evaluateNightClose(review),
      pending: pendingView(rows),
      reprogrammed: rows.length,
      penalty: NIGHT_PENALTY_POINTS,
      message: `El día no se cierra. ${rows.length} tarea(s) vuelven al plan de mañana con +${NIGHT_PENALTY_POINTS} de prioridad y tu razón queda registrada.`,
    });
  } catch (error) {
    console.error('[planner/night] error:', error);
    return NextResponse.json(
      { error: 'No se ha podido cerrar el día. Revisa la consola del servidor.' },
      { status: 500 }
    );
  }
}
