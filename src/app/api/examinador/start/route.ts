import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { buildExamPackage, PAU_TIMED_MINUTES } from '@/lib/examinador';

export const dynamic = 'force-dynamic';

/**
 * Crea una sesión de simulacro PAU: genera los bloques (IA o plantillas
 * locales) y los guarda en la sesión para poder retomarla aunque se recargue.
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as { subjectId?: unknown } | null;
  const subjectId = typeof body?.subjectId === 'string' ? body.subjectId : '';

  if (!subjectId) {
    return NextResponse.json({ error: 'Falta el identificador de la asignatura.' }, { status: 400 });
  }

  const subject = await prisma.subject.findUnique({
    where: { id: subjectId },
    select: { name: true },
  });

  if (!subject) {
    return NextResponse.json({ error: 'Asignatura no encontrada.' }, { status: 404 });
  }

  try {
    const pkg = await buildExamPackage(subjectId);

    const session = await prisma.pauExamSession.create({
      data: {
        subjectName: subject.name,
        timedMinutes: PAU_TIMED_MINUTES,
        elapsedMinutes: 0,
        questionsJson: JSON.stringify(pkg),
      },
    });

    return NextResponse.json({
      ok: true,
      sessionId: session.id,
      source: pkg.source,
      model: pkg.model ?? null,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'No se pudo generar el simulacro. Inténtalo de nuevo.';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
