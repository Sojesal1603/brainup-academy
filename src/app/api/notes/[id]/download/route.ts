import { NextResponse } from 'next/server';
import { sanitizeNoteContent } from '@/lib/apuntesIa';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth';

/**
 * Descarga de un apunte en Markdown.
 *
 * El cuaderno vive en tu SQLite y se pinta con KaTeX, pero para **imprimir,
 * llevar al instituto o reutilizar en otro sitio** hace falta el archivo. Aquí
 * se sirve el apunte como `.md` autocontenido: una cabecera con sus datos
 * (asignatura, unidad, quién lo ha escrito y cuándo) y después el contenido
 * **tal cual lo escribió** quien lo escribió, sin reescribirlo ni reajustarlo.
 *
 * Lo único que se hace es pasar el apunte por el limpiador: los apuntes viejos
 * guardados antes de que existiera la limpieza pueden traer vallas de código,
 * HTML o etiquetas internas, y un archivo para imprimir no es sitio para eso.
 *
 * No se toca nada de la base: es una lectura.
 */

/** Convierte el título en un nombre de archivo seguro (sin acentos ni símbolos). */
function slugifyFileName(value: string, fallback = 'apunte'): string {
  const slug = String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');

  return slug.length > 0 ? slug : fallback;
}

/** Fecha en español, para la cabecera del apunte. */
function formatNoteDate(date: Date): string {
  return date.toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
}

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const user = await requireUser();
  const note = await db(user.id).note.findFirst({
    where: { id },
    include: {
      topic: {
        include: { subject: { select: { name: true } } },
      },
      agent: { select: { name: true } },
    },
  });

  if (!note) {
    return NextResponse.json({ error: 'Apunte no encontrado.' }, { status: 404 });
  }

  const unit = note.topic.unitNumber
    ? `U${note.topic.unitNumber} · ${note.topic.title}`
    : note.topic.title;

  const fromCatedratico = note.author === 'catedratico';
  const authorLine = fromCatedratico
    ? `El catedrático ${note.agent?.name ?? 'IA'}`
    : 'Tus apuntes';

  const markdown = [
    `# ${note.title}`,
    '',
    `> **Apunte** · ${note.topic.subject.name}`,
    `> **Unidad**: ${unit}`,
    `> **Autor**: ${authorLine}`,
    `> **Fecha**: ${formatNoteDate(note.updatedAt)}`,
    '',
    '---',
    '',
    sanitizeNoteContent(note.content),
    '',
    '---',
    '',
    '_BrainUp Academy_',
    '',
  ].join('\n');

  const fileName = `${slugifyFileName(note.title)}.md`;
  const asciiName = fileName.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'");

  return new NextResponse(markdown, {
    status: 200,
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      'Cache-Control': 'private, max-age=0, must-revalidate',
    },
  });
}
