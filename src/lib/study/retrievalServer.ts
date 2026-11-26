/**
 * Lectura del corpus persistente para la recuperación estricta.
 *
 * La consulta va con `db(userId)` **y** con `userId` explícito en el `where`:
 * son dos capas a propósito. El cliente acotado inyecta el dueño, y el filtro
 * explícito deja la intención escrita para que una futura consulta cruda no
 * pueda olvidarlo.
 *
 * No se traen los binarios: solo los trozos que ya están indexados. El texto de
 * una nota se trocea en `retrieval.ts`; aquí solo se leen documentos.
 */

import { db } from '@/lib/db';
import type { RetrievalSourceChunk } from './retrieval';

export async function loadSourceChunksForSubject(
  userId: string,
  subjectId: string
): Promise<RetrievalSourceChunk[]> {
  const documents = await db(userId).sourceDocument.findMany({
    where: { userId, subjectId, status: 'READY' },
    orderBy: { createdAt: 'desc' },
    take: 16,
    select: {
      id: true,
      title: true,
      chunks: {
        orderBy: { order: 'asc' },
        take: 600,
        select: {
          id: true,
          order: true,
          label: true,
          text: true,
          pageFrom: true,
          pageTo: true,
        },
      },
    },
  });

  return documents.flatMap((document) =>
    document.chunks.map((chunk) => ({
      id: chunk.id,
      userId,
      kind: 'document' as const,
      sourceId: document.id,
      sourceTitle: document.title,
      label: chunk.label,
      pageFrom: chunk.pageFrom,
      pageTo: chunk.pageTo,
      text: chunk.text,
      order: chunk.order,
    }))
  );
}
