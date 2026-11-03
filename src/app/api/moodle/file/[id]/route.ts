import { NextResponse } from 'next/server';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '@/lib/prisma';
import { isSafeMoodleFileUrl } from '@/lib/moodleWs';
import { getMoodleConnection, safeLocalFileName } from '@/lib/moodleWsSync';

/**
 * Sirve un apunte de Moodle sin exponer el token.
 *
 * El navegador pide `/api/moodle/file/<id>`; aquí se busca el material, se le
 * añade el token a la URL de pluginfile en el servidor, se descarga y se
 * guarda una copia local (`data/moodle/`). A partir de la segunda vez se sirve
 * de esa copia: los apuntes quedan offline.
 */

const MAX_CACHED_BYTES = 40 * 1024 * 1024;

const INLINE_MIME = /^(application\/pdf|image\/|text\/plain|text\/markdown|audio\/|video\/)/i;

function fileResponse(buffer: Buffer, fileName: string, mimeType: string | null, download: boolean) {
  const asciiName = fileName.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'");
  const disposition = download || !mimeType || !INLINE_MIME.test(mimeType) ? 'attachment' : 'inline';

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'Content-Type': mimeType || 'application/octet-stream',
      'Content-Length': String(buffer.byteLength),
      'Content-Disposition': `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      'Cache-Control': 'private, max-age=0, must-revalidate',
    },
  });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const download = new URL(request.url).searchParams.get('download') === '1';

  const material = await prisma.moodleMaterial.findUnique({
    where: { id },
    include: { course: { select: { fullName: true, shortName: true } } },
  });

  if (!material) {
    return NextResponse.json({ error: 'Ese apunte no está en tu índice de Moodle.' }, { status: 404 });
  }

  const fileName = safeLocalFileName(material.name);
  const cacheDir = path.join(process.cwd(), 'data', 'moodle');
  const cachePath = path.join(cacheDir, `${material.id}-${fileName}`);

  // 1. Copia local (ya descargado antes): funciona sin conexión.
  try {
    const info = await stat(cachePath);
    if (info.isFile() && info.size > 0) {
      const buffer = await readFile(cachePath);
      return fileResponse(buffer, material.name, material.mimeType, download);
    }
  } catch {
    // Sin copia local: se descarga.
  }

  const connection = await getMoodleConnection();
  if (!connection) {
    return NextResponse.json(
      { error: 'Tu Moodle no está conectado: vuelve a pegar la dirección y el token en Ajustes.' },
      { status: 400 }
    );
  }

  // 2. Sin archivo descargable (página, enlace, carpeta…): se manda a Moodle.
  if (!material.downloadUrl || !isSafeMoodleFileUrl(material.downloadUrl, connection.baseUrl)) {
    if (material.webUrl) {
      return NextResponse.redirect(material.webUrl, 302);
    }
    return NextResponse.json(
      { error: 'Este recurso no tiene archivo: ábrelo en Moodle. Puede que el token no dé acceso al curso.' },
      { status: 404 }
    );
  }

  const url = new URL(material.downloadUrl);
  url.searchParams.set('token', connection.token);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': 'BrainUpAcademy/1.0 (descarga de apuntes)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: `No se pudo descargar «${material.name}» de Moodle (${detail}).` },
      { status: 502 }
    );
  }

  if (!response.ok) {
    return NextResponse.json(
      {
        error: `Moodle ha respondido con HTTP ${response.status} al pedir «${material.name}». Puede que el token haya caducado o no tenga permiso para ese curso.`,
      },
      { status: 502 }
    );
  }

  // Redirección a otro sitio: no seguimos (el token no viaja fuera de tu Moodle).
  try {
    const finalHost = new URL(response.url).host;
    if (finalHost !== new URL(connection.baseUrl).host) {
      return NextResponse.json(
        { error: 'Moodle ha redirigido el archivo a otro dominio; por seguridad no lo he descargado.' },
        { status: 502 }
      );
    }
  } catch {
    // Sin URL final utilizable: seguimos con lo descargado.
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  if (buffer.byteLength > 0 && buffer.byteLength <= MAX_CACHED_BYTES) {
    try {
      await mkdir(cacheDir, { recursive: true });
      await writeFile(cachePath, buffer);
      await prisma.moodleMaterial.update({
        where: { id: material.id },
        data: { localPath: path.relative(process.cwd(), cachePath), fetchedAt: new Date() },
      });
    } catch (error) {
      // Si no se puede cachear, se sirve igual: no es un fallo para el alumno.
      console.error('[moodle] no se pudo guardar la copia local:', error instanceof Error ? error.message : error);
    }
  }

  const contentType = material.mimeType ?? response.headers.get('content-type');
  return fileResponse(buffer, material.name, contentType, download);
}
