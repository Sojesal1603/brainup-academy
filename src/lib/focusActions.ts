'use server';

import { revalidatePath } from 'next/cache';
import { currentTenant } from './tenantContext';
import {
  FOCUS_MIN_JUSTIFICATION,
  evaluateFocusPenalty,
  type FocusPenalty,
} from './focusLock';
import { incrementTutorSeconds } from './reviewCards';

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function clampInt(value: unknown, min: number, max: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return min;
  return Math.min(max, Math.max(min, Math.round(num)));
}

export interface StartFocusResult {
  success: boolean;
  error?: string;
  sessionId?: string;
  startedAtIso?: string;
  /** Bloque del plan al que se ha vinculado el enfoque (si lo había). */
  blockId?: string | null;
}

/** Arranca un bloque de Focus y marca la sesión del plan como «en curso». */
export async function startFocusSession(input: {
  topicId?: string | null;
  blockId?: string | null;
  plannedMinutes: number;
}): Promise<StartFocusResult> {
  const { user, tenant: prisma } = await currentTenant();
  const plannedMinutes = clampInt(input?.plannedMinutes, 5, 180);
  const topicId =
    typeof input?.topicId === 'string' && input.topicId.length > 0
      ? input.topicId
      : null;
  const blockId =
    typeof input?.blockId === 'string' && input.blockId.length > 0
      ? input.blockId
      : null;

  if (topicId) {
    const topic = await prisma.topic.findUnique({
      where: { id: topicId },
      select: { id: true },
    });
    if (!topic) {
      return { success: false, error: 'La unidad elegida ya no existe.' };
    }
  }

  // Si el alumno no elige un bloque explícito, se vincula al primer bloque vivo
  // de hoy de esa unidad. Sin esto, el temporizador no podría cerrar la tarea
  // del plan y la penalización no sabría qué quedó incompleto.
  let linkedBlockId = blockId;
  if (!linkedBlockId && topicId) {
    const todayStart = startOfDay(new Date());
    const pending = await prisma.studyBlock.findFirst({
      where: {
        topicId,
        date: { gte: todayStart, lt: new Date(todayStart.getTime() + 86_400_000) },
        isCompleted: false,
        status: { in: ['pendiente', 'en_curso', 'parcial'] },
      },
      orderBy: { orderIndex: 'asc' },
      select: { id: true },
    });
    linkedBlockId = pending?.id ?? null;
  }

  const session = await prisma.focusSession.create({
    data: {
      topicId,
      blockId: linkedBlockId,
      plannedMinutes,
      status: 'running',
    },
    select: { id: true, startedAt: true },
  });

  if (linkedBlockId) {
    await prisma.studyBlock.updateMany({
      where: { id: linkedBlockId, isCompleted: false },
      data: { status: 'en_curso' },
    });
  }

  revalidatePath('/');
  return {
    success: true,
    sessionId: session.id,
    startedAtIso: session.startedAt.toISOString(),
    blockId: linkedBlockId,
  };
}

/** Sincroniza los segundos reales mientras el bloque sigue vivo. */
export async function syncFocusSession(input: {
  sessionId: string;
  focusedSeconds: number;
  pausedSeconds: number;
  interruptions: number;
}): Promise<{ success: boolean }> {
  const { user, tenant: prisma } = await currentTenant();
  if (typeof input?.sessionId !== 'string' || input.sessionId.length === 0) {
    return { success: false };
  }

  await prisma.focusSession.updateMany({
    where: { id: input.sessionId, status: { in: ['running', 'paused'] } },
    data: {
      focusedSeconds: clampInt(input.focusedSeconds, 0, 24 * 3600),
      pausedSeconds: clampInt(input.pausedSeconds, 0, 24 * 3600),
      interruptions: clampInt(input.interruptions, 0, 99),
    },
  });

  return { success: true };
}

/** Segundos de consulta al catedrático durante un bloque activo. */
export async function registerTutorTime(
  sessionId: string,
  seconds: number
): Promise<{ success: boolean }> {
  const { user, tenant: prisma } = await currentTenant();
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return { success: false };
  }
  await incrementTutorSeconds(user.id, sessionId, clampInt(seconds, 1, 120));
  return { success: true };
}

/** Cierra el bloque como completado y congela los totales. */
export async function completeFocusSession(input: {
  sessionId: string;
  focusedSeconds: number;
  pausedSeconds: number;
  /** Si se omite, se conservan los segundos que ya había sumado el chat. */
  tutorSeconds?: number;
  interruptions: number;
}): Promise<{ success: boolean; error?: string }> {
  const { user, tenant: prisma } = await currentTenant();
  if (typeof input?.sessionId !== 'string' || input.sessionId.length === 0) {
    return { success: false, error: 'Falta la sesión de enfoque.' };
  }

  const session = await prisma.focusSession.findUnique({
    where: { id: input.sessionId },
    select: { id: true, status: true },
  });
  if (!session) {
    return { success: false, error: 'Esa sesión de enfoque ya no existe.' };
  }
  if (session.status === 'abandoned') {
    return { success: false, error: 'La sesión ya estaba abandonada.' };
  }

  await prisma.focusSession.update({
    where: { id: session.id },
    data: {
      focusedSeconds: clampInt(input.focusedSeconds, 0, 24 * 3600),
      pausedSeconds: clampInt(input.pausedSeconds, 0, 24 * 3600),
      ...(typeof input.tutorSeconds === 'number'
        ? { tutorSeconds: clampInt(input.tutorSeconds, 0, 24 * 3600) }
        : {}),
      interruptions: clampInt(input.interruptions, 0, 99),
      status: 'completed',
      endedAt: new Date(),
    },
  });

  revalidatePath('/');
  return { success: true };
}

export interface AbandonFocusResult {
  success: boolean;
  error?: string;
  penalty?: FocusPenalty;
  scheduledBlocks?: number;
  message?: string;
}

/**
 * Abandona una sesión y aplica la penalización del Guardián Nocturno.
 *
 * - sube la prioridad de lo que queda pendiente hoy,
 * - crea bloques de Active Recall para mañana según el volumen calculado,
 * - deja constancia en la memoria del día.
 *
 * Es idempotente por sesión: abandonar dos veces no duplica los bloques extra.
 */
export async function abandonFocusSession(input: {
  sessionId: string;
  reason?: string | null;
  pendingTasks?: number;
  totalTasks?: number;
}): Promise<AbandonFocusResult> {
  const { user, tenant: prisma } = await currentTenant();
  if (typeof input?.sessionId !== 'string' || input.sessionId.length === 0) {
    return { success: false, error: 'Falta la sesión de enfoque.' };
  }

  const session = await prisma.focusSession.findUnique({
    where: { id: input.sessionId },
    include: { topic: { select: { id: true, title: true } } },
  });

  if (!session) {
    return { success: false, error: 'Esa sesión de enfoque ya no existe.' };
  }
  if (session.status === 'completed') {
    return { success: false, error: 'La sesión ya estaba completada.' };
  }
  if (session.status === 'abandoned') {
    return { success: true, scheduledBlocks: 0, message: 'La sesión ya estaba abandonada.' };
  }

  const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 900) : '';
  const justified = reason.length >= FOCUS_MIN_JUSTIFICATION;
  const plannedMinutes = Math.max(1, session.plannedMinutes);
  const focusedMinutes = Math.round(session.focusedSeconds / 60);

  const penalty = evaluateFocusPenalty({
    interruptions: session.interruptions + 1,
    pendingTasks: clampInt(input.pendingTasks, 0, 20),
    totalTasks: clampInt(input.totalTasks, 0, 20),
    abandoned: true,
    justified,
    focusedMinutes,
    plannedMinutes,
  });

  const now = new Date();
  const todayStart = startOfDay(now);
  const todayEnd = new Date(todayStart.getTime() + 86_400_000);
  const tomorrow = new Date(todayStart.getTime() + 86_400_000);

  await prisma.focusSession.update({
    where: { id: session.id },
    data: {
      status: 'abandoned',
      endedAt: now,
      abandonReason: reason || null,
      focusedSeconds: session.focusedSeconds,
      interruptions: session.interruptions + 1,
    },
  });

  // 1. Prioridad para lo que sigue pendiente hoy.
  if (penalty.priorityPoints > 0) {
    await prisma.studyBlock.updateMany({
      where: {
        date: { gte: todayStart, lt: todayEnd },
        isCompleted: false,
        status: { in: ['pendiente', 'parcial', 'en_curso'] },
      },
      data: { priorityScore: { increment: penalty.priorityPoints } },
    });
  }

  // 2. Volumen extra de repaso para mañana, solo para la unidad del bloque.
  let scheduledBlocks = 0;
  if (session.topicId && penalty.extraReviewBlocks > 0) {
    const already = await prisma.studyBlock.findFirst({
      where: {
        topicId: session.topicId,
        date: { gte: tomorrow, lt: new Date(tomorrow.getTime() + 86_400_000) },
        reason: { contains: session.id },
      },
      select: { id: true },
    });

    if (!already) {
      for (let index = 0; index < penalty.extraReviewBlocks; index++) {
        await prisma.studyBlock.create({
          data: {
            topicId: session.topicId,
            date: tomorrow,
            durationMinutes: 10,
            technique: 'srs_review',
            mode: 'athlete',
            isCompleted: false,
            orderIndex: 90 + index,
            objective: 'Repaso extra por bloque abandonado',
            reason: `Penalización Focus & Lock (${session.id}): ${penalty.reason}`,
            material: 'Active Recall · tarjetas y errores del bloque',
            stage: 'repaso',
            breakMinutes: 5,
            status: 'pendiente',
            priorityScore: 85,
            origin: 'recuperacion',
            spentMinutes: 0,
          },
        });
        scheduledBlocks += 1;
      }
    }
  }

  // 3. Memoria del día para que el cierre nocturno lo cuente.
  await prisma.agentMemory.upsert({
    where: {
      userId_scope_day: {
        userId: user.id,
        scope: `focus-abandon-${session.id}`,
        day: todayStart.toISOString().slice(0, 10),
      },
    },
    create: {
      scope: `focus-abandon-${session.id}`,
      day: todayStart.toISOString().slice(0, 10),
      summary: `Sesión de Focus abandonada${
        session.topic ? ` en «${session.topic.title}»` : ''
      }: ${justified ? reason : 'sin justificación'}. ${penalty.message}`,
      factsJson: JSON.stringify({
        sessionId: session.id,
        topicId: session.topicId,
        focusedMinutes,
        plannedMinutes,
        interruptions: session.interruptions + 1,
        penalty,
        scheduledBlocks,
      }),
      writtenBy: 'reglas',
    },
    update: {
      summary: `Sesión de Focus abandonada: ${justified ? reason : 'sin justificación'}. ${penalty.message}`,
      factsJson: JSON.stringify({
        sessionId: session.id,
        topicId: session.topicId,
        focusedMinutes,
        plannedMinutes,
        penalty,
        scheduledBlocks,
      }),
      writtenBy: 'reglas',
    },
  });

  revalidatePath('/');
  revalidatePath('/planificador');

  return {
    success: true,
    penalty,
    scheduledBlocks,
    message: `Sesión cerrada. ${penalty.message}`,
  };
}
