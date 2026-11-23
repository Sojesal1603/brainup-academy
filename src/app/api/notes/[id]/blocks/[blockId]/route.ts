import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { updateBlockContent } from '@/lib/study/notes';
import { studyErrorResponse } from '@/lib/study/http';

/**
 * Guarda una edición del alumno.
 *
 * Es el único punto que pone `isEdited = true`; a partir de ahí, cualquier
 * regeneración conserva el bloque. El Markdown se valida por tamaño y se guarda
 * tal cual: la app no reescribe lo que ha escrito una persona.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; blockId: string }> }
) {
  try {
    const user = await requireUser();
    const { id, blockId } = await params;
    const body = (await request.json().catch(() => null)) as { content?: unknown } | null;
    const content = typeof body?.content === 'string' ? body.content : '';

    if (content.trim().length === 0) {
      return NextResponse.json({ error: 'Un bloque no puede quedarse vacío.' }, { status: 400 });
    }
    if (content.length > 20_000) {
      return NextResponse.json(
        { error: 'Ese bloque es demasiado largo para guardarlo de una vez.' },
        { status: 413 }
      );
    }

    const result = await updateBlockContent({
      userId: user.id,
      noteId: id,
      blockId,
      content,
    });

    return NextResponse.json({ ok: true, markdown: result.markdown });
  } catch (error) {
    return studyErrorResponse(error, 'No se ha podido guardar el bloque.');
  }
}
