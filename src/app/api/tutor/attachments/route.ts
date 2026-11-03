import { createReadStream } from 'fs';
import { Readable } from 'stream';
import { NextResponse } from 'next/server';
import { MAX_ATTACHMENT_BYTES, formatBytes } from '@/lib/attachmentLimits';
import { deleteUpload, readUpload, saveUploadFromStream } from '@/lib/docStore';

/**
 * La puerta de los archivos del catedrático: subir, recuperar y borrar.
 *
 * Es una puerta **aparte** del chat a propósito. El mensaje del chat es pequeño
 * (texto y los identificadores de los archivos); el archivo viene aquí, en crudo
 * y en streaming, así que su tamaño no depende de lo que el navegador sea capaz
 * de meter en un JSON. Y como el servidor lo escribe en disco mientras llega, un
 * documento de 300 MB no pasa nunca entero por la memoria de nadie.
 *
 *   - `PUT`    → sube **un** archivo (nombre y tipo en cabeceras, cuerpo = bytes).
 *   - `GET`    → devuelve el archivo (para reabrirlo desde el historial del chat).
 *   - `DELETE` → lo borra (el alumno ha quitado el adjunto antes de enviarlo).
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Las cabeceras del navegador pueden venir codificadas (`encodeURIComponent`). */
function headerValue(request: Request, name: string): string {
  const raw = request.headers.get(name) ?? '';
  try {
    return decodeURIComponent(raw);
  } catch {
    // Si no venía codificado, se usa tal cual: no hay nada que decodificar.
    return raw;
  }
}

export async function PUT(request: Request) {
  const name = headerValue(request, 'x-file-name').trim();
  const mimeType = headerValue(request, 'x-file-type').trim();

  if (name.length === 0) {
    return NextResponse.json({ error: 'El archivo necesita un nombre.' }, { status: 400 });
  }
  if (!request.body) {
    return NextResponse.json(
      { error: `La petición de «${name}» no trae el archivo.` },
      { status: 400 }
    );
  }

  // Si el navegador ya dice cuánto pesa, se contesta antes de mover un solo byte.
  const declared = Number(request.headers.get('x-file-size') ?? '');
  if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_BYTES) {
    return NextResponse.json(
      {
        error: `«${name}» pesa ${formatBytes(declared)} y el tope por archivo es ${formatBytes(
          MAX_ATTACHMENT_BYTES
        )}. Divídelo (por ejemplo, por temas) y sube cada parte.`,
        code: 'too_big',
      },
      { status: 413 }
    );
  }

  const result = await saveUploadFromStream(request.body, {
    name,
    mimeType,
    maxBytes: MAX_ATTACHMENT_BYTES,
  });

  if (!result.ok) {
    const status = result.code === 'too_big' ? 413 : result.code === 'disco' ? 500 : 400;
    return NextResponse.json({ error: result.error, code: result.code ?? 'invalid' }, { status });
  }

  const { upload } = result;

  // Se devuelve lo que ha pasado de verdad con el documento: cuántas páginas,
  // si se ha podido leer su texto y con qué avisos. El chat lo enseña tal cual.
  return NextResponse.json({
    ok: true,
    upload: {
      id: upload.id,
      name: upload.name,
      mimeType: upload.mimeType,
      sizeBytes: upload.sizeBytes,
      kind: upload.kind,
      mode: upload.mode,
      pages: upload.pages,
      chars: upload.chars,
      notes: upload.notes,
    },
  });
}

export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get('id') ?? '';
  const upload = await readUpload(id);
  if (!upload) {
    return NextResponse.json({ error: 'Ese archivo ya no está.' }, { status: 404 });
  }

  try {
    // Se sirve el binario en streaming: un documento grande se descarga sin
    // cargarse entero en memoria. El tipo se ajusta porque el `ReadableStream`
    // de Node y el del DOM son el mismo objeto con dos declaraciones distintas.
    const body = Readable.toWeb(createReadStream(upload.path)) as unknown as ReadableStream<Uint8Array>;
    return new NextResponse(body, {
      headers: {
        'Content-Type': upload.mimeType,
        'Content-Length': String(upload.sizeBytes),
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(upload.name)}`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch {
    return NextResponse.json({ error: 'No se ha podido abrir el archivo.' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get('id') ?? '';
  const deleted = await deleteUpload(id);
  return NextResponse.json({ ok: true, deleted });
}
