/**
 * Auditoría de cierre del día.
 *
 * El bucle del sistema no se cierra solo por mirar el reloj: a partir de las
 * 21:00, si quedan bloques obligatorios sin terminar, el día queda BLOQUEADO.
 * No se puede cerrar; solo cabe terminarlos o aplazarlos con una razón, y en ese
 * caso vuelven al plan de mañana con penalización de prioridad.
 *
 * Este módulo es puro (sin Prisma ni red) para poder probar la regla aislada de
 * la base de datos y de la interfaz.
 */

import type { DayReview } from './dayPlan';

/** A partir de esta hora empieza la auditoría de cierre. */
export const NIGHT_START_HOUR = 21;
/** A partir de aquí el aviso es de prórroga: el día lleva abierto demasiado. */
export const NIGHT_HARD_HOUR = 23;
/** Puntos de prioridad que se suman a cada bloque aplazado. */
export const NIGHT_PENALTY_POINTS = 25;
/** Justificación mínima para aplazar (caracteres). */
export const NIGHT_MIN_JUSTIFICATION = 20;

/** Ámbito de memoria donde se registra que el día se cerró limpio. */
export const NIGHT_CLOSE_SCOPE = 'cierre-dia';
/** Ámbito donde queda constancia de un aplazamiento y su motivo. */
export const NIGHT_DELAY_SCOPE = 'aplazamiento-dia';

export type NightPhase = 'dia' | 'noche' | 'cerrado';

export interface NightCloseState {
  phase: NightPhase;
  /** No se puede cerrar la jornada: hay tareas obligatorias vivas. */
  locked: boolean;
  pending: number;
  pendingMinutes: number;
  message: string;
  penaltyPoints: number;
  minJustification: number;
}

function clock(now: Date): string {
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Estado de cierre para la foto real del día (`reviewDayProgress`).
 *
 * `closed` es lo único que no se puede deducir de los números: lo escribe el
 * servidor cuando el alumno cierra la jornada con cero pendientes.
 */
export function evaluateNightClose(
  review: Pick<
    DayReview,
    'pendingBlocks' | 'inProgressBlocks' | 'pendingMinutes' | 'inProgressMinutes'
  >,
  now: Date = new Date(),
  closed = false
): NightCloseState {
  const pending = review.pendingBlocks + review.inProgressBlocks;
  const pendingMinutes = review.pendingMinutes + review.inProgressMinutes;

  // Un cierre viejo no vale si después han entrado tareas nuevas: si hay algo
  // vivo, el día vuelve a estar abierto y bloqueado.
  if (closed && pending === 0) {
    return {
      phase: 'cerrado',
      locked: false,
      pending,
      pendingMinutes,
      message: 'Día cerrado. Mañana el Planificador arranca con lo que quede vivo.',
      penaltyPoints: NIGHT_PENALTY_POINTS,
      minJustification: NIGHT_MIN_JUSTIFICATION,
    };
  }

  if (now.getHours() < NIGHT_START_HOUR) {
    return {
      phase: 'dia',
      locked: false,
      pending,
      pendingMinutes,
      message: '',
      penaltyPoints: NIGHT_PENALTY_POINTS,
      minJustification: NIGHT_MIN_JUSTIFICATION,
    };
  }

  if (pending === 0) {
    return {
      phase: 'noche',
      locked: false,
      pending,
      pendingMinutes,
      message: 'No queda ninguna tarea obligatoria. El día se puede cerrar.',
      penaltyPoints: NIGHT_PENALTY_POINTS,
      minJustification: NIGHT_MIN_JUSTIFICATION,
    };
  }

  const late = now.getHours() >= NIGHT_HARD_HOUR;
  const message = late
    ? `Son las ${clock(now)} y el día sigue abierto con ${plural(pending, 'tarea obligatoria', 'tareas obligatorias')} (${pendingMinutes} min). No se cierra: termínalas ahora o aplázalas con una razón. Mañana vuelven al principio del plan con +${NIGHT_PENALTY_POINTS} de prioridad.`
    : `Quedan ${plural(pending, 'tarea obligatoria', 'tareas obligatorias')} (${pendingMinutes} min). El día no se cierra hasta que estén hechas o aplazadas con una razón. Si las aplazas, vuelven mañana con +${NIGHT_PENALTY_POINTS} de prioridad.`;

  return {
    phase: 'noche',
    locked: true,
    pending,
    pendingMinutes,
    message,
    penaltyPoints: NIGHT_PENALTY_POINTS,
    minJustification: NIGHT_MIN_JUSTIFICATION,
  };
}
