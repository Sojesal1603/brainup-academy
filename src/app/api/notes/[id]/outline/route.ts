import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { activateAiCredentials, ensureAiAccess } from '@/lib/ai/access';
import { hasAiProviderAsync } from '@/lib/aiEngine';
import { fallbackOutlineForNote, generateOutlineForNote, type OutlineResult } from '@/lib/study/generate';
import {
  createOutlineSections,
  loadNoteTree,
  reorderSections,
  serializeNoteTree,
  setSectionStatus,
} from '@/lib/study/notes';
import { studyErrorResponse } from '@/lib/study/http';

/**
 * Esquema Outline-First.
 *
 * GET  → el árbol actual (para el lienzo y para reanudar).
 * POST → propone los apartados en segundos, sin redactar el cuerpo. Si el
 *        apunte ya tiene árbol, no se vuelve a gastar una llamada: se devuelve
 *        el que hay (regenerarlo borraría trabajo del alumno).
 * PATCH → reordena apartados o marca uno como omitido.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function noteForOutline(userId: string, noteId: string) {
  return db(userId).note.findFirst({
    where: { id: noteId },
    include: {
      topic: { include: { subject: { select: { id: true, name: true } } } },
      agent: { select: { name: true } },
      sections: {
        orderBy: { order: 'asc' },
        include: { blocks: { orderBy: { order: 'asc' } } },
      },
    },
  });
}

export async function GET(
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
    return NextResponse.json({ note: serializeNoteTree(note) });
  } catch (error) {
    return studyErrorResponse(error, 'No se ha podido cargar el esquema del apunte.');
  }
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireUser();
    const { id } = await params;

    const note = await noteForOutline(user.id, id);
    if (!note) {
      return NextResponse.json({ error: 'Ese apunte ya no está en el cuaderno.' }, { status: 404 });
    }

    if (note.sections.length > 0) {
      return NextResponse.json({
        created: false,
        note: serializeNoteTree(note),
        message: 'Este apunte ya tiene esquema: no se ha vuelto a generar para no perder tus cambios.',
      });
    }

    // La forma que espera el generador: la unidad con su asignatura colgando
    // de ella, no repartida por el árbol de Prisma.
    const outlineNote = {
      title: note.title,
      topicId: note.topicId,
      topic: {
        id: note.topic.id,
        title: note.topic.title,
        unitNumber: note.topic.unitNumber,
        teacherMethod: note.topic.teacherMethod,
      },
      subject: note.topic.subject,
    };

    let outline: OutlineResult;
    const providerReady = await hasAiProviderAsync();

    if (!providerReady) {
      outline = await fallbackOutlineForNote({ userId: user.id, note: outlineNote });
    } else {
      const ai = await ensureAiAccess(user.id);
      if (ai.denied) {
        // Sin clave el esquema sigue siendo útil: se prepara con las etiquetas
        // de las fuentes y se avisa, en vez de bloquear el lienzo con un 402.
        outline = await fallbackOutlineForNote({ userId: user.id, note: outlineNote });
      } else {
        activateAiCredentials(ai.credentials);
        try {
          outline = await generateOutlineForNote({ userId: user.id, note: outlineNote });
        } catch (error) {
          console.warn(
            `[lienzo] esquema con IA fallido, se usa el de respaldo: ${
              error instanceof Error ? error.message : 'error desconocido'
            }`
          );
          outline = await fallbackOutlineForNote({ userId: user.id, note: outlineNote });
        }
      }
    }

    const created = await createOutlineSections({
      userId: user.id,
      noteId: id,
      sections: outline.sections,
      chunks: outline.context.chunks,
    });

    const saved = await loadNoteTree(user.id, id);
    return NextResponse.json({
      created: created.created,
      fallback: outline.fallback,
      warning: outline.warning,
      model: outline.model,
      note: saved ? serializeNoteTree(saved) : null,
    });
  } catch (error) {
    return studyErrorResponse(error, 'No se ha podido preparar el esquema del apunte.');
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as
      | { sectionIds?: unknown; sectionId?: unknown; status?: unknown }
      | null;

    if (body && Array.isArray(body.sectionIds)) {
      const sectionIds = body.sectionIds.filter((item): item is string => typeof item === 'string');
      const result = await reorderSections({ userId: user.id, noteId: id, sectionIds });
      return NextResponse.json({ ok: true, markdown: result.markdown });
    }

    if (body && typeof body.sectionId === 'string') {
      const status = body.status === 'SKIPPED' ? 'SKIPPED' : 'PENDING';
      const result = await setSectionStatus({
        userId: user.id,
        noteId: id,
        sectionId: body.sectionId,
        status,
      });
      return NextResponse.json({ ok: true, markdown: result.markdown });
    }

    return NextResponse.json(
      { error: 'Indica `sectionIds` para ordenar o `sectionId` + `status` para omitir.' },
      { status: 400 }
    );
  } catch (error) {
    return studyErrorResponse(error, 'No se ha podido actualizar el esquema.');
  }
}
