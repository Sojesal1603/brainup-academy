import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { activateAiCredentials, ensureAiAccess } from '@/lib/ai/access';
import { readUpload, readUploadBytes } from '@/lib/docStore';
import { MAX_INLINE_ATTACHMENT_BYTES, isImageMime } from '@/lib/attachmentLimits';
import { transcribeHandwriting } from '@/lib/corrector';
import type { AiAttachmentPart } from '@/lib/aiEngine';

export const dynamic = 'force-dynamic';

/**
 * Transcripción de una foto manuscrita para el Examinador.
 *
 * El alumno ya ha subido el archivo por el pipeline de adjuntos normal y aquí
 * solo llega su id. Se transcribe con un modelo con visión —el motor no manda
 * imágenes a modelos de texto— y se devuelve el texto con su **confianza**: si
 * la letra no se lee, se dice antes de corregir nada.
 */
export async function POST(request: NextRequest) {
  const user = await requireUser();
  const ai = await ensureAiAccess(user.id);
  if (ai.denied) return ai.denied;
  activateAiCredentials(ai.credentials);

  const body = (await request.json().catch(() => null)) as {
    uploadId?: unknown;
    subjectName?: unknown;
    blockPrompt?: unknown;
  } | null;

  const uploadId = typeof body?.uploadId === 'string' ? body.uploadId : '';
  if (!uploadId) {
    return NextResponse.json({ error: 'Falta el identificador del archivo.' }, { status: 400 });
  }

  const upload = await readUpload(user.id, uploadId).catch(() => null);
  if (!upload) {
    return NextResponse.json({ error: 'Ese archivo no existe o no es tuyo.' }, { status: 404 });
  }
  if (!isImageMime(upload.mimeType)) {
    return NextResponse.json(
      { error: 'La transcripción manuscrita solo acepta imágenes (foto o escaneo).' },
      { status: 415 }
    );
  }
  if (upload.sizeBytes > MAX_INLINE_ATTACHMENT_BYTES) {
    return NextResponse.json(
      { error: 'La imagen pesa demasiado para leerla con visión. Hazla una foto más ligera.' },
      { status: 413 }
    );
  }

  const bytes = await readUploadBytes(user.id, uploadId).catch(() => null);
  if (!bytes) {
    return NextResponse.json({ error: 'No se ha podido leer el archivo.' }, { status: 404 });
  }

  const attachment: AiAttachmentPart = {
    name: upload.name,
    mimeType: upload.mimeType,
    data: bytes.toString('base64'),
  };

  const transcription = await transcribeHandwriting({
    attachments: [attachment],
    subjectName: typeof body?.subjectName === 'string' ? body.subjectName.slice(0, 120) : undefined,
    blockPrompt:
      typeof body?.blockPrompt === 'string' ? body.blockPrompt.slice(0, 2_000) : undefined,
  });

  if (!transcription) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'No hay un modelo con visión disponible ahora mismo, así que no se ha transcrito la foto. Escribe tu respuesta o inténtalo más tarde.',
      },
      { status: 503 }
    );
  }

  return NextResponse.json({
    ok: true,
    text: transcription.text,
    confidence: transcription.confidence,
    missingParts: transcription.missingParts,
    note: transcription.note,
    model: transcription.model,
  });
}
