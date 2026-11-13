import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { formatNotebookLmContent } from '@/lib/notebooklm';

export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const prisma = db(user.id);
    const body = await req.json();
    const { topicId, title, content, flowId } = body;

    if (!topicId || typeof topicId !== 'string') {
      return NextResponse.json({ error: 'Falta topicId obligatorio' }, { status: 400 });
    }

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return NextResponse.json({ error: 'El contenido no puede estar vacío' }, { status: 400 });
    }

    const topic = await prisma.topic.findFirst({
      where: { id: topicId },
      include: { subject: true },
    });

    if (!topic) {
      return NextResponse.json({ error: 'Tema no encontrado' }, { status: 404 });
    }

    // Formatear citas para el visor Notion de BrainUp
    const formattedContent = formatNotebookLmContent(content);
    const noteTitle = title?.trim() || `NotebookLM: ${topic.title}`;
    const tags = `notebooklm,${flowId || 'estudio'},${topic.subject.name.toLowerCase().replace(/\s+/g, '_')}`;

    const newNote = await prisma.note.create({
      data: {
        topicId: topic.id,
        title: noteTitle,
        content: formattedContent,
        tags,
        author: 'catedratico',
        isPinned: false,
      },
    });

    // Si el tema estaba en "no_empezado" o "pendiente", actualizar a "en_curso"
    if (topic.status === 'pendiente') {
      await prisma.topic.update({
        where: { id: topic.id },
        data: { status: 'en_curso' },
      });
    }

    return NextResponse.json({
      success: true,
      noteId: newNote.id,
      title: newNote.title,
      subjectName: topic.subject.name,
    });
  } catch (error) {
    console.error('[notebooklm/import] error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Error al guardar apunte' },
      { status: 500 }
    );
  }
}
