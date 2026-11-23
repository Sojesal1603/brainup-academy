import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { activateAiCredentials, ensureAiAccess } from '@/lib/ai/access';
import { loadNoteTree } from '@/lib/study/notes';
import { studyErrorResponse } from '@/lib/study/http';

/**
 * Crea el trabajo de desarrollar el tema entero.
 *
 * No redacta aquí: una petición HTTP con timeout de proxy no es sitio para doce
 * secciones. Devuelve el id del `StudyJob`; el cliente pide ticks y ve el
 * progreso real. Si Render reinicia a mitad, el trabajo sigue en la fila.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireUser();
    const { id } = await params;

    const note = await loadNoteTree(user.id, id);
    if (!note) {
      return NextResponse.json({ error: 'Ese apunte ya no está en el cuaderno.' }, { status: 404 });
    }

    const pending = note.sections.filter((section) => section.status === 'PENDING');
    if (pending.length === 0) {
      return NextResponse.json(
        { error: 'No hay apartados pendientes: el esquema está desarrollado u omitido.' },
        { status: 409 }
      );
    }

    const ai = await ensureAiAccess(user.id);
    if (ai.denied) return ai.denied;
    activateAiCredentials(ai.credentials);

    const running = await db(user.id).studyJob.findFirst({
      where: { noteId: id, status: { in: ['queued', 'running'] } },
      select: { id: true },
    });
    if (running) {
      return NextResponse.json({ jobId: running.id, resumed: true });
    }

    const job = await db(user.id).studyJob.create({
      data: {
        userId: user.id,
        noteId: id,
        kind: 'note_sections',
        status: 'queued',
        step: 0,
        totalSteps: pending.length,
        inputJson: JSON.stringify({ sectionIds: pending.map((section) => section.id) }),
      },
    });

    return NextResponse.json({ jobId: job.id, totalSteps: pending.length });
  } catch (error) {
    return studyErrorResponse(error, 'No se ha podido preparar el trabajo completo.');
  }
}
