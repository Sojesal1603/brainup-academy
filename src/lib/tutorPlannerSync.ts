/**
 * El puente obligatorio entre los catedráticos y el Planificador.
 *
 * Cuando el catedrático mide el nivel de una unidad y sale flojo, eso no puede
 * quedarse en una etiqueta del chat: se convierte en trabajo real. Este módulo
 * hace las dos cosas que el alumno espera sin pedirlas:
 *
 *   1. **Lo apunta como error de concepto abierto** (una sola ficha por unidad)
 *      para que el banco de errores y el motor de sesiones lo vean.
 *   2. **Rehace el plan de hoy** con `persistDayPlan`, que respeta lo completado
 *      y lo que está en marcha y recoloca lo pendiente con la unidad débil arriba.
 *
 * La otra dirección (Planificador → catedrático) la lleva el prompt: la ruta del
 * tutor le pasa el plan de hoy en `todayPlan`.
 *
 * No toca los repasos (SRS): un diagnóstico no es un repaso hecho. Reprogramar
 * el calendario con una fecha inventada sería falsear la analítica de retención.
 */

import { prisma } from './prisma';
import { persistDayPlan } from './dayPlan';

/** Por debajo de este nivel medido, la unidad pide refuerzo inmediato. */
export const WEAK_MASTERY_THRESHOLD = 60;

/** Marca que distingue las fichas que crea el catedrático de las del alumno. */
export const DIAGNOSTIC_ERROR_PREFIX = '[diagnóstico del catedrático]';

export interface TutorPlannerSyncInput {
  subjectId: string;
  topicId: string;
  unitNumber: number | null;
  unitTitle: string;
  /** Nivel medido por el catedrático (0-100). */
  mastery: number;
  agentName: string;
  conversationId: string | null;
}

export interface TutorPlannerSyncResult {
  /** ¿Se ha tocado el plan? */
  synced: boolean;
  reason: string;
  /** ¿Se ha abierto una ficha nueva en el banco de errores? */
  registeredError: boolean;
  /** Sesiones creadas al rehacer el plan de hoy. */
  created: number;
  plannedMinutes: number;
}

/**
 * Sincroniza el diagnóstico del catedrático con la agenda del alumno.
 *
 * Es idempotente: si la unidad ya tiene una ficha de diagnóstico abierta, no
 * crea otra. El plan sí se rehace siempre que el nivel sea flojo, porque el
 * alumno puede haber cambiado de hora o de tiempo disponible desde la última vez.
 */
export async function syncTutorWithPlanner(
  input: TutorPlannerSyncInput
): Promise<TutorPlannerSyncResult> {
  const mastery = Number.isFinite(input.mastery)
    ? Math.max(0, Math.min(100, Math.round(input.mastery)))
    : 0;

  if (mastery >= WEAK_MASTERY_THRESHOLD) {
    return {
      synced: false,
      reason: `nivel medido ${mastery}%: por encima del umbral de refuerzo (${WEAK_MASTERY_THRESHOLD}%)`,
      registeredError: false,
      created: 0,
      plannedMinutes: 0,
    };
  }

  const unitLabel = `${input.unitNumber ? `U${input.unitNumber} · ` : ''}«${input.unitTitle}»`;

  let registeredError = false;
  try {
    const existing = await prisma.errorLog.findFirst({
      where: {
        topicId: input.topicId,
        isMastered: false,
        questionPrompt: { startsWith: DIAGNOSTIC_ERROR_PREFIX },
      },
      select: { id: true },
    });

    if (!existing) {
      await prisma.errorLog.create({
        data: {
          subjectId: input.subjectId,
          topicId: input.topicId,
          questionPrompt: `${DIAGNOSTIC_ERROR_PREFIX} ${unitLabel}`,
          myAnswer: `En el diagnóstico del catedrático ${input.agentName} no ha demostrado dominio del concepto (${mastery}%).`,
          correctAnswer: 'Dominio completo del concepto, explicado con sus propias palabras y aplicado sin ayuda.',
          rootCause: 'concepto',
          keyLesson: `El concepto de ${unitLabel} hay que reconstruirlo desde la base antes de seguir con lo siguiente.`,
          correctiveAction: 'Sesión de comprensión + recuperación activa en el plan de hoy, y repaso corto antes del examen.',
        },
      });
      registeredError = true;
    }
  } catch (error) {
    console.error('[planificador] no se ha podido abrir la ficha de diagnóstico:', error);
  }

  try {
    const plan = await persistDayPlan({});
    return {
      synced: true,
      reason: `nivel medido ${mastery}% en ${unitLabel}: unidad débil programada en el plan de hoy`,
      registeredError,
      created: plan.created,
      plannedMinutes: plan.plannedMinutes,
    };
  } catch (error) {
    console.error('[planificador] no se ha podido rehacer el plan tras el diagnóstico:', error);
    return {
      synced: false,
      reason: `nivel medido ${mastery}% en ${unitLabel}, pero el plan no se ha podido recalcular ahora mismo`,
      registeredError,
      created: 0,
      plannedMinutes: 0,
    };
  }
}
