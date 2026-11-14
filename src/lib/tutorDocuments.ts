import { db } from './db';

/**
 * `open_document(kind, query)` adaptado al flujo actual, sin SSE.
 *
 * Se ejecuta SIEMPRE en servidor y recibe el `userId` de la sesión como primer
 * argumento; el modelo no puede pasar ni elegir un dueño. Devuelve al modelo
 * solo lo que necesita saber: `{ ok, title }`. El id y el contenido se quedan
 * en el servidor para que el panel los pinte con el cliente acotado.
 */
export interface OpenedDocument {
  ok: boolean;
  title: string | null;
  /** Uso interno del servidor; no se manda al modelo. */
  noteId?: string;
}

export async function openDocument(
  userId: string,
  kind: 'note',
  query: string
): Promise<OpenedDocument> {
  const value = String(query ?? '').trim();
  if (value.length === 0 || value.length > 200) return { ok: false, title: null };

  const note = await db(userId).note.findFirst({
    where: {
      OR: [{ id: value }, { title: { contains: value, mode: 'insensitive' } }],
    },
    orderBy: [{ isPinned: 'desc' }, { updatedAt: 'desc' }],
    select: { id: true, title: true },
  });

  return note ? { ok: true, title: note.title, noteId: note.id } : { ok: false, title: null };
}
