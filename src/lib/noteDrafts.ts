/**
 * Apuntes redactados que todavía **no** están en el cuaderno.
 *
 * El catedrático propone unos apuntes, el alumno dice que sí… y antes se
 * escribían directamente. El problema es que redactar un apunte es la llamada
 * más cara del sistema (miles de tokens) y no siempre convence a la primera:
 * quien lo lee quiere poder decir «esta estructura no me sirve».
 *
 * Así que hay un paso intermedio: se redacta, se le enseña **tal y como va a
 * quedar** y solo se guarda si le convence. Este módulo guarda ese borrador unos
 * minutos para que, al darle a «guardar», **no se genere otra vez**: se escribe
 * exactamente lo que ha visto (y no gasta una segunda llamada de cupo, que con
 * cupos gratuitos es la diferencia entre tener apuntes o no tenerlos).
 *
 * Vive en memoria a propósito: un borrador es algo efímero y no tiene sentido
 * escribirlo en la base. Si el servidor se reinicia, el borrador se pierde y se
 * le dice al alumno que vuelva a pedirlos; nada de lo suyo se queda a medias.
 */

import { randomUUID } from 'node:crypto';

export interface NoteDraft {
  /** Id del catedrático que los ha escrito (para colgarlos de su asignatura). */
  /**
   * Cuenta que ha pedido el borrador.
   *
   * El vale viaja al navegador y vuelve en la petición de guardado. Sin el dueño
   * aquí, un vale filtrado (logs, historial, una pestaña compartida) permitiría a
   * otra cuenta guardar el apunte con SU userId: el contenido sería de la
   * primera cuenta y la fila de la segunda.
   */
  userId: string;
  agentId: string;
  /** Id de la unidad del temario a la que pertenecen. */
  topicId: string;
  /** Conversación de la que salen, si se sabe. */
  conversationId: string | null;
  title: string;
  content: string;
  /** Lo medido al salir: se enseña en la vista previa. */
  words: number;
  developedPoints: number;
  /** Estructura que le falta, si le falta algo. */
  structureMissing: string[];
  model: string;
  provider: string;
  at: number;
}

/** Cuánto dura un borrador antes de descartarse. */
const DRAFT_TTL_MS = 45 * 60 * 1000;
/** Cuántos borradores se guardan a la vez (es una caché, no un almacén). */
const MAX_DRAFTS = 24;

const drafts = new Map<string, NoteDraft>();

/** Quita los borradores caducados (se llama al guardar y al leer). */
function prune(now = Date.now()): void {
  for (const [token, draft] of drafts) {
    if (now - draft.at > DRAFT_TTL_MS) drafts.delete(token);
  }
  // Si aun así sobran, se van los más viejos: los últimos son los que el alumno
  // tiene delante en el chat.
  if (drafts.size > MAX_DRAFTS) {
    const ordered = [...drafts.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [token] of ordered.slice(0, drafts.size - MAX_DRAFTS)) drafts.delete(token);
  }
}

/** Guarda un borrador y devuelve el vale para poder guardarlo después. */
export function rememberNoteDraft(draft: Omit<NoteDraft, 'at'>): string {
  prune();
  const token = randomUUID();
  drafts.set(token, { ...draft, at: Date.now() });
  return token;
}

/**
 * Recupera un borrador (sin gastarlo) para poder enseñarlo o guardarlo.
 *
 * Exige el `userId` de la sesión: un vale de otra cuenta se comporta como si no
 * existiera. No se distingue «caducado» de «de otra cuenta» a propósito, para no
 * confirmar que ese vale existe.
 */
export function peekNoteDraft(userId: string, token: string): NoteDraft | null {
  prune();
  const draft = drafts.get(token);
  if (!draft || draft.userId !== userId) return null;
  return draft;
}

/** Gasta el borrador: una vez guardado, el vale ya no vale. */
export function takeNoteDraft(userId: string, token: string): NoteDraft | null {
  const draft = peekNoteDraft(userId, token);
  if (draft) drafts.delete(token);
  return draft;
}

/** Cuántos borradores hay ahora mismo (para las pruebas). */
export function countNoteDrafts(): number {
  prune();
  return drafts.size;
}
