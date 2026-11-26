import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { activateAiCredentials, ensureAiAccess } from '@/lib/ai/access';
import { generateSectionForNote } from '@/lib/study/generate';
import { loadNoteTree } from '@/lib/study/notes';
import { studyErrorResponse } from '@/lib/study/http';

/**
 * Desarrolla **un** apartado del esquema.
 *
 * Es la unidad de trabajo del lienzo: se paga solo lo que el alumno pide, tarda
 * segundos y, si el alumno ya había editado un bloque de esa sección, se
 * conserva (la política vive en `notes.ts`, no en la ruta).
 *
 * No borra ni regenera el esquema: si la sección no existe, es un 404.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; sectionId: string }> }
) {
  try {
    const user = await requireUser();
    const { id, sectionId } = await params;

    const note = await loadNoteTree(user.id, id);
    if (!note) {
      return NextResponse.json({ error: 'Ese apunte ya no está en el cuaderno.' }, { status: 404 });
    }

    const section = note.sections.find((item) => item.id === sectionId);
    if (!section) {
      return NextResponse.json({ error: 'Ese apartado ya no está en el apunte.' }, { status: 404 });
    }
    if (section.status === 'SKIPPED') {
      return NextResponse.json(
        { error: 'Ese apartado está omitido. Recupéralo antes de desarrollarlo.' },
        { status: 409 }
      );
    }

    const ai = await ensureAiAccess(user.id);
    if (ai.denied) return ai.denied;
    activateAiCredentials(ai.credentials);

    const result = await generateSectionForNote({
      userId: user.id,
      noteId: note.id,
      note: {
        title: note.title,
        topicId: note.topicId,
        topic: {
          title: note.topic.title,
          teacherMethod: note.topic.teacherMethod,
        },
        subject: { id: note.topic.subject.id, name: note.topic.subject.name },
      },
      section: {
        id: section.id,
        title: section.title,
        purpose: section.purpose,
        status: section.status,
      },
      siblingTitles: note.sections
        .filter((item) => item.id !== section.id && item.status !== 'SKIPPED')
        .map((item) => item.title),
    });

    return NextResponse.json({
      ok: true,
      warning: result.warning,
      generation: result.generation,
    });
  } catch (error) {
    return studyErrorResponse(error, 'No se ha podido desarrollar el apartado.');
  }
}
