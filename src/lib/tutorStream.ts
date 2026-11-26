/**
 * Contrato mínimo del streaming del catedrático.
 *
 * Módulo puro (sin Next, sin base de datos): la ruta lo usa para escribir los
 * eventos y `verify:marca` lo usa para auditar que el marco SSE es correcto y
 * que las frases de estado no nombran proveedores ni modelos.
 */

/** Eventos que puede emitir `POST /api/tutor` en modo SSE. */
export const TUTOR_STREAM_EVENTS = [
  'open',
  'heartbeat',
  'status',
  'delta',
  'done',
  'error',
] as const;

export type TutorStreamEvent = (typeof TUTOR_STREAM_EVENTS)[number];

/**
 * Frases de estado: pedagógicas y de la academia. Nunca «consultando Gemini».
 */
export const TUTOR_STREAM_STATUS_LINES = [
  'Leyendo tu expediente…',
  'Repasando tus apuntes y tu temario…',
  'Preparando una explicación a tu medida…',
  'Revisando que las cuentas y los pasos cuadren…',
] as const;

/** Un evento SSE bien formado. El `data` viaja como JSON de una sola línea. */
export function tutorSseFrame(event: TutorStreamEvent, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
