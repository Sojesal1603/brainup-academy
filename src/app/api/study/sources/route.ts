import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { ingestSource, listSources, MAX_SOURCE_BYTES } from '@/lib/study/sources';
import { studyErrorResponse } from '@/lib/study/http';

/**
 * Fuentes del alumno: listar y subir.
 *
 * La subida pasa por esta ruta (no va directa al bucket) para poder comprobar
 * el tipo real, calcular el sha256 y extraer el texto antes de crear la fila.
 * El archivo se escribe en una carpeta temporal del sistema y se borra siempre,
 * haya ido bien o mal.
 *
 * Sin almacén configurado se usa `data/objects` (desarrollo y pruebas). Con R2,
 * las mismas claves viven en el bucket y sobreviven a un redespliegue de Render.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const user = await requireUser();
    const sources = await listSources(user.id);
    return NextResponse.json({
      sources: sources.map((source) => ({
        id: source.id,
        title: source.title,
        kind: source.kind,
        pages: source.pages,
        chars: source.chars,
        status: source.status,
        mode: source.mode,
        subjectId: source.subjectId,
        topicId: source.topicId,
        chunks: source._count.chunks,
        createdAt: source.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    return studyErrorResponse(error, 'No se han podido cargar tus fuentes.');
  }
}

export async function POST(request: Request) {
  const tempFile = path.join(os.tmpdir(), `brainup-source-${randomUUID()}`);

  try {
    const user = await requireUser();
    const form = await request.formData();
    const file = form.get('file');

    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: 'Falta el archivo. Adjúntalo en el campo «file».' },
        { status: 400 }
      );
    }
    if (file.size === 0) {
      return NextResponse.json({ error: 'El archivo ha llegado vacío.' }, { status: 400 });
    }
    if (file.size > MAX_SOURCE_BYTES) {
      return NextResponse.json(
        {
          error: `El archivo pesa más de ${Math.round(
            MAX_SOURCE_BYTES / (1024 * 1024)
          )} MB, que es el tope por fuente.`,
        },
        { status: 413 }
      );
    }

    const topicId = String(form.get('topicId') ?? '').trim() || null;
    const subjectIdRaw = String(form.get('subjectId') ?? '').trim() || null;
    const title = String(form.get('title') ?? '').trim() || undefined;

    let subjectId = subjectIdRaw;
    let defaultTitle: string | undefined = title;

    if (topicId) {
      const topic = await db(user.id).topic.findFirst({
        where: { id: topicId },
        select: { id: true, subjectId: true, title: true },
      });
      if (!topic) {
        return NextResponse.json({ error: 'Esa unidad no está en tu temario.' }, { status: 404 });
      }
      subjectId = topic.subjectId;
      defaultTitle = title ?? topic.title;
    } else if (subjectId) {
      const subject = await db(user.id).subject.findFirst({
        where: { id: subjectId },
        select: { id: true },
      });
      if (!subject) {
        return NextResponse.json({ error: 'Esa asignatura no está en tu temario.' }, { status: 404 });
      }
    }

    await writeFile(tempFile, Buffer.from(await file.arrayBuffer()));

    const ingested = await ingestSource({
      userId: user.id,
      filePath: tempFile,
      name: file.name || 'documento',
      mimeType: file.type || 'application/octet-stream',
      title: defaultTitle,
      subjectId,
      topicId,
    });

    return NextResponse.json({ source: ingested }, { status: ingested.deduplicated ? 200 : 201 });
  } catch (error) {
    return studyErrorResponse(error, 'No se ha podido guardar la fuente.');
  } finally {
    await rm(tempFile, { force: true }).catch(() => {});
  }
}
