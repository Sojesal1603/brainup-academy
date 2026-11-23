import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { activateAiCredentials, ensureAiAccess } from '@/lib/ai/access';
import { generateSectionForNote } from '@/lib/study/generate';
import { loadNoteTree } from '@/lib/study/notes';
import { studyErrorResponse } from '@/lib/study/http';

/**
 * Avanza **un** paso de un trabajo largo.
 *
 * El `step` se incrementa ANTES de generar y solo si coincide con el que leyó
 * esta petición: dos ticks simultáneos no hacen la misma sección dos veces (el
 * segundo recibe 409 y reintenta con el estado nuevo). No hay worker ni Redis:
 * el estado vive en `StudyJob` y sobrevive a un reinicio de Render.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireUser();
    const { id } = await params;

    const job = await db(user.id).studyJob.findFirst({ where: { id } });
    if (!job) {
      return NextResponse.json({ error: 'Ese trabajo ya no existe.' }, { status: 404 });
    }
    if (!job.noteId) {
      return NextResponse.json({ error: 'El trabajo no apunta a ningún apunte.' }, { status: 409 });
    }
    if (job.status === 'done' || job.status === 'failed') {
      return NextResponse.json({
        job: { id: job.id, status: job.status, step: job.step, totalSteps: job.totalSteps },
        finished: true,
      });
    }

    const note = await loadNoteTree(user.id, job.noteId);
    if (!note) {
      await db(user.id).studyJob.update({
        where: { id: job.id },
        data: { status: 'failed', error: 'El apunte ya no existe.' },
      });
      return NextResponse.json({ error: 'El apunte ya no existe.' }, { status: 409 });
    }

    const pending = note.sections.filter((section) => section.status === 'PENDING');
    if (pending.length === 0) {
      const finished = await db(user.id).studyJob.update({
        where: { id: job.id },
        data: { status: 'done', error: null },
      });
      return NextResponse.json({
        job: {
          id: finished.id,
          status: finished.status,
          step: finished.step,
          totalSteps: finished.totalSteps,
        },
        finished: true,
      });
    }

    // Reclamo optimista: si otro tick ya avanzó este paso, este no hace nada.
    const claimed = await db(user.id).studyJob.updateMany({
      where: { id: job.id, step: job.step, status: { in: ['queued', 'running'] } },
      data: { step: job.step + 1, status: 'running' },
    });
    if (claimed.count === 0) {
      return NextResponse.json(
        { error: 'Otro paso de este trabajo se está ejecutando.', retry: true },
        { status: 409 }
      );
    }

    const ai = await ensureAiAccess(user.id);
    if (ai.denied) {
      await db(user.id).studyJob.update({
        where: { id: job.id },
        data: { status: 'failed', error: 'Sin clave de IA para seguir desarrollando.' },
      });
      return ai.denied;
    }
    activateAiCredentials(ai.credentials);

    const section = pending[0];

    try {
      const result = await generateSectionForNote({
        userId: user.id,
        noteId: note.id,
        note: {
          title: note.title,
          topicId: note.topicId,
          topic: { title: note.topic.title, teacherMethod: note.topic.teacherMethod },
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

      const left = pending.length - 1;
      const updated = await db(user.id).studyJob.update({
        where: { id: job.id },
        data: {
          status: left > 0 ? 'queued' : 'done',
          resultJson: JSON.stringify({
            lastSectionId: section.id,
            verified: result.generation.verified,
            warning: result.warning,
          }),
        },
      });

      return NextResponse.json({
        job: {
          id: updated.id,
          status: updated.status,
          step: updated.step,
          totalSteps: updated.totalSteps,
        },
        section: {
          id: section.id,
          title: section.title,
          status: result.generation.status,
        },
        warning: result.warning,
        finished: left === 0,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 300) : 'error desconocido';
      await db(user.id).studyJob.update({
        where: { id: job.id },
        data: { status: 'failed', error: message },
      });
      throw error;
    }
  } catch (error) {
    return studyErrorResponse(error, 'No se ha podido avanzar el trabajo.');
  }
}
