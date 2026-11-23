import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { loadNoteTree } from '@/lib/study/notes';
import { studyErrorResponse } from '@/lib/study/http';

/** Estado de un trabajo largo, para el anillo de progreso del lienzo. */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireUser();
    const { id } = await params;

    const job = await db(user.id).studyJob.findFirst({
      where: { id },
      select: {
        id: true,
        noteId: true,
        status: true,
        step: true,
        totalSteps: true,
        error: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!job) {
      return NextResponse.json({ error: 'Ese trabajo ya no existe.' }, { status: 404 });
    }

    const note = job.noteId ? await loadNoteTree(user.id, job.noteId) : null;

    return NextResponse.json({
      job: {
        ...job,
        createdAt: job.createdAt.toISOString(),
        updatedAt: job.updatedAt.toISOString(),
      },
      sections: note
        ? note.sections.map((section) => ({
            id: section.id,
            title: section.title,
            status: section.status,
          }))
        : [],
    });
  } catch (error) {
    return studyErrorResponse(error, 'No se ha podido consultar el trabajo.');
  }
}
