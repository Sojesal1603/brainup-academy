import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { buildEbauPackage } from '@/lib/ebauSimulator';
import {
  getEbauCommunity,
  isEbauCommunity,
} from '@/lib/ebauCommunities';

export const dynamic = 'force-dynamic';

/**
 * Crea una sesión de simulacro EBAU con la estructura de la comunidad del
 * alumno. Si el cuerpo trae una comunidad válida, se guarda en el perfil para
 * que el siguiente simulacro la use por defecto.
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as
    | { subjectId?: unknown; community?: unknown }
    | null;
  const subjectId = typeof body?.subjectId === 'string' ? body.subjectId : '';

  if (!subjectId) {
    return NextResponse.json({ error: 'Falta el identificador de la asignatura.' }, { status: 400 });
  }

  const subject = await prisma.subject.findUnique({
    where: { id: subjectId },
    select: { name: true, user: { select: { community: true } } },
  });

  if (!subject) {
    return NextResponse.json({ error: 'Asignatura no encontrada.' }, { status: 404 });
  }

  const requested = isEbauCommunity(body?.community) ? body.community : null;
  const community = getEbauCommunity(requested ?? subject.user?.community);

  if (requested && requested !== subject.user?.community) {
    await prisma.userProfile.updateMany({
      where: { id: 'user_default' },
      data: { community: community.code },
    });
  }

  try {
    const pkg = await buildEbauPackage({
      subjectId,
      communityCode: community.code,
    });

    const session = await prisma.pauExamSession.create({
      data: {
        subjectName: subject.name,
        subjectId,
        community: community.code,
        timedMinutes: community.durationMinutes,
        elapsedMinutes: 0,
        questionsJson: JSON.stringify(pkg),
      },
    });

    return NextResponse.json({
      ok: true,
      sessionId: session.id,
      source: pkg.source,
      model: pkg.model ?? null,
      community: community.code,
      communityName: community.name,
      structure: pkg.structure ?? null,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'No se pudo generar el simulacro. Inténtalo de nuevo.';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
