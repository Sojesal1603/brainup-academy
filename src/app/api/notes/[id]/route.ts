import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { sanitizeNoteContent } from '@/lib/apuntesIa';

/**
 * Un apunte, en JSON, para el panel de lectura del catedrático.
 *
 * La vista dividida enseña el documento al lado del chat. La descarga
 * (`/api/notes/[id]/download`) sirve un `.md` con cabecera para imprimir, que no
 * es lo que se quiere pintar aquí: el panel necesita el contenido limpio y los
 * datos de la unidad para poner el encabezado. Es una lectura, no escribe nada.
 */

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await requireUser();
  const { id } = await params;

  const note = await db(user.id).note.findFirst({
    where: { id },
    include: {
      topic: { include: { subject: { select: { name: true } } } },
      agent: { select: { name: true } },
    },
  });

  if (!note) {
    return NextResponse.json({ error: 'Ese apunte ya no está en el cuaderno.' }, { status: 404 });
  }

  return NextResponse.json({
    note: {
      id: note.id,
      title: note.title,
      // El mismo limpiador que el cuaderno: lo guardado antes de que existiera
      // la limpieza se lee aquí igual de limpio.
      content: sanitizeNoteContent(note.content),
      unitNumber: note.topic.unitNumber,
      unitTitle: note.topic.title,
      subjectName: note.topic.subject.name,
      author: note.author,
      agentName: note.agent?.name ?? null,
      updatedAt: note.updatedAt.toISOString(),
    },
  });
}
