/**
 * Focus & Lock: reglas del cronómetro y de la penalización por procrastinación.
 *
 * Módulo puro, a propósito. El temporizador del navegador no decide cuánto
 * castiga una sesión abandonada: eso se calcula aquí, con números acotados, y
 * el servidor lo aplica después al plan. Si la regla viviera en el componente,
 * cualquiera podría saltársela cerrando la pestaña.
 *
 * Qué se considera interrupción:
 *   - abandonar la sesión sin una razón real (mínimo 20 caracteres),
 *   - hacerlo con el bloque a menos del 80% de los minutos previstos,
 *   - las interrupciones acumuladas (pestaña oculta, pausas forzadas).
 *
 * La penalización tiene dos partes, como pide el Guardián Nocturno:
 *   - **prioridad** para lo que quedó pendiente (vuelve antes al plan),
 *   - **volumen de repaso** extra para mañana (bloques de Active Recall).
 */

export const FOCUS_PRESETS = [25, 50] as const;
export type FocusPreset = (typeof FOCUS_PRESETS)[number];

/** Mínimo de caracteres para que una razón cuente como justificación. */
export const FOCUS_MIN_JUSTIFICATION = 20;

/** Clave de localStorage donde vive el bloque de Focus activo. */
export const FOCUS_SESSION_STORAGE_KEY = 'brainup.focusSession';

export const FOCUS_MAX_PRIORITY_PENALTY = 60;
export const FOCUS_MAX_EXTRA_REVIEW_MINUTES = 30;

export interface FocusPenaltyInput {
  interruptions: number;
  /** Tareas del bloque que quedan sin hacer. */
  pendingTasks: number;
  totalTasks: number;
  abandoned: boolean;
  /** ¿La razón escrita es real (>= FOCUS_MIN_JUSTIFICATION)? */
  justified: boolean;
  focusedMinutes: number;
  plannedMinutes: number;
}

export interface FocusPenalty {
  priorityPoints: number;
  extraReviewMinutes: number;
  extraReviewBlocks: number;
  /** 0-100: porcentaje del bloque que sí se ha trabajado. */
  completionPercent: number;
  reason: string;
  message: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Calcula el castigo de una sesión de Focus.
 *
 * Sin abandono y con el bloque hecho no hay castigo. Abandonar sin razón es lo
 * más caro (+40 de prioridad y 20 min extra de repaso); con una razón real se
 * reconoce el imprevisto, pero el trabajo pendiente sigue subiendo de prioridad.
 */
export function evaluateFocusPenalty(input: FocusPenaltyInput): FocusPenalty {
  const planned = Math.max(1, Math.round(input.plannedMinutes));
  const focused = clamp(Math.round(input.focusedMinutes), 0, planned * 2);
  const completionPercent = clamp(Math.round((focused / planned) * 100), 0, 100);
  const interruptions = clamp(Math.round(input.interruptions), 0, 10);
  const totalTasks = Math.max(0, Math.round(input.totalTasks));
  const pendingTasks = clamp(Math.round(input.pendingTasks), 0, Math.max(0, totalTasks));

  const incompleteRatio =
    totalTasks > 0
      ? pendingTasks / totalTasks
      : abandonedOrShort(completionPercent, input.abandoned);

  let priorityPoints = Math.min(30, interruptions * 8);
  let extraReviewMinutes = Math.round((incompleteRatio * 20) / 5) * 5;

  if (input.abandoned) {
    if (input.justified) {
      priorityPoints += 10;
      extraReviewMinutes = Math.max(5, extraReviewMinutes);
    } else {
      priorityPoints += 40;
      extraReviewMinutes = Math.max(20, extraReviewMinutes);
    }
  }

  priorityPoints = clamp(priorityPoints, 0, FOCUS_MAX_PRIORITY_PENALTY);
  extraReviewMinutes = clamp(
    extraReviewMinutes,
    0,
    FOCUS_MAX_EXTRA_REVIEW_MINUTES
  );

  const extraReviewBlocks = Math.ceil(extraReviewMinutes / 10);

  const reason = input.abandoned
    ? input.justified
      ? 'Sesión abandonada con justificación: el trabajo pendiente sube de prioridad.'
      : 'Sesión abandonada sin justificación: penalización completa del Guardián Nocturno.'
    : interruptions > 0
      ? 'Sesión con interrupciones: el bloque vuelve con más prioridad.'
      : 'Sesión completada sin penalización.';

  const message =
    priorityPoints === 0 && extraReviewMinutes === 0
      ? 'Bloque limpio: sin penalización para mañana.'
      : `+${priorityPoints} de prioridad y ${extraReviewMinutes} min de repaso extra${
          extraReviewBlocks > 0 ? ` (${extraReviewBlocks} bloque(s))` : ''
        } para mañana.`;

  return {
    priorityPoints,
    extraReviewMinutes,
    extraReviewBlocks,
    completionPercent,
    reason,
    message,
  };
}

/** Un bloque que se abandona antes de tiempo también cuenta como incompleto. */
function abandonedOrShort(completionPercent: number, abandoned: boolean): number {
  if (abandoned) return 1;
  if (completionPercent >= 80) return 0;
  return Math.max(0, (80 - completionPercent) / 80);
}

/** Tiempo efectivo sobre tiempo total de la sesión (0-100). */
export function focusEffectiveness(
  focusedSeconds: number,
  elapsedSeconds: number
): number {
  if (elapsedSeconds <= 0) return 0;
  return clamp(Math.round((focusedSeconds / elapsedSeconds) * 100), 0, 100);
}

/** Relación estudio/tutor: cuánto del tiempo con la app es estudio real. */
export function studyVsTutorRatio(
  focusedSeconds: number,
  tutorSeconds: number
): number {
  const total = focusedSeconds + tutorSeconds;
  if (total <= 0) return 0;
  return clamp(Math.round((focusedSeconds / total) * 100), 0, 100);
}
