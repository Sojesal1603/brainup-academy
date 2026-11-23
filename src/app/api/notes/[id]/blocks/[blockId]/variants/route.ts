import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { activateAiCredentials, ensureAiAccess } from '@/lib/ai/access';
import { canAddVariant, VARIANT_KINDS, type VariantKind, type BlockLike } from '@/lib/study/blocks';
import { generateVariantForBlock } from '@/lib/study/generate';
import { addBlockVariant, loadNoteTree } from '@/lib/study/notes';
import { packPromptChunks } from '@/lib/study/prompts';
import { selectSourceContext } from '@/lib/study/sources';
import { studyErrorResponse } from '@/lib/study/http';

/**
 * Pide una variante hija de un bloque: «más sencillo», «un ejemplo» o «más
 * profundo».
 *
 * La profundidad se comprueba **antes** de gastar una llamada: dos niveles como
 * máximo. La variante se guarda como bloque hijo, nunca sustituye al original.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; blockId: string }> }
) {
  try {
    const user = await requireUser();
    const { id, blockId } = await params;

    const body = (await request.json().catch(() => null)) as { kind?: unknown } | null;
    const kind = body?.kind;
    if (kind !== 'simpler' && kind !== 'example' && kind !== 'deeper') {
      return NextResponse.json(
        { error: 'Indica `kind`: simpler, example o deeper.' },
        { status: 400 }
      );
    }

    const note = await loadNoteTree(user.id, id);
    if (!note) {
      return NextResponse.json({ error: 'Ese apunte ya no está en el cuaderno.' }, { status: 404 });
    }

    const all = note.sections.flatMap((section) => section.blocks);
    const parent = all.find((block) => block.id === blockId);
    if (!parent) {
      return NextResponse.json({ error: 'Ese bloque ya no está en el apunte.' }, { status: 404 });
    }

    const byId = new Map<string, Pick<BlockLike, 'id' | 'parentId'>>(
      all.map((block) => [block.id, { id: block.id, parentId: block.parentId }])
    );
    const allowedDepth = canAddVariant(blockId, byId);
    if (!allowedDepth.ok) {
      return NextResponse.json({ error: allowedDepth.reason }, { status: 409 });
    }

    const ai = await ensureAiAccess(user.id);
    if (ai.denied) return ai.denied;
    activateAiCredentials(ai.credentials);

    const context = await selectSourceContext({
      userId: user.id,
      topicId: note.topicId,
      subjectId: note.topic.subject.id,
      query: parent.content.slice(0, 800),
      budgetChars: 14_000,
      maxChunks: 8,
    });

    const chunks = packPromptChunks(context.chunks, 14_000);
    if (chunks.length === 0) {
      return NextResponse.json(
        {
          error:
            'No hay fuentes con texto para ampliar este bloque. Sube el material de la unidad primero.',
        },
        { status: 409 }
      );
    }

    const generated = await generateVariantForBlock({
      userId: user.id,
      noteId: id,
      subjectName: note.topic.subject.name,
      topicTitle: note.topic.title,
      parentBlock: { id: parent.id, content: parent.content },
      variant: kind as VariantKind,
      chunks,
      allowed: context.allowed,
    });

    const saved = await addBlockVariant({
      userId: user.id,
      noteId: id,
      parentId: blockId,
      block: {
        type: generated.block.type,
        content: generated.block.content,
        chunkId: generated.block.chunkId ?? null,
        quote: generated.block.quote ?? null,
        quoteStatus: generated.block.quoteStatus as 'VERIFIED' | 'UNVERIFIED' | 'ERROR' | 'NONE',
        citationReason: generated.block.citationReason,
      },
    });

    return NextResponse.json({
      ok: true,
      block: {
        id: saved.id,
        parentId: blockId,
        depth: saved.depth,
        label: VARIANT_KINDS[kind].label,
        content: generated.block.content,
        quoteStatus: generated.block.quoteStatus,
      },
      markdown: saved.markdown,
    });
  } catch (error) {
    return studyErrorResponse(error, 'No se ha podido ampliar el bloque.');
  }
}
