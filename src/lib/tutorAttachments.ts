/**
 * Adjuntos del catedrático IA: lo que le enseñas.
 *
 * El alumno puede pasarle capturas de pantalla, fotos del cuaderno, enunciados
 * escaneados y PDFs (de Moodle, del libro o de su profesor). Este módulo se
 * ocupa de tres cosas y solo tres:
 *
 *   1. Decidir qué se acepta (tipos y tamaños) y rechazar lo demás con un
 *      mensaje claro, antes de gastar una llamada de IA.
 *   2. Guardar una copia en `data/uploads/` para que el archivo siga ahí sin
 *      conexión y el historial se pueda reenviar al modelo.
 *   3. Reconstruir las partes multimodales de un turno antiguo.
 *
 * Regla de coste: la *binary* de un archivo solo se reenvía al modelo durante
 * los últimos `ATTACHMENT_LIVE_TURNS` turnos que llevaban adjunto. A partir de
 * ahí el historial conserva el nombre (el catedrático sabe que existió y puede
 * pedir que se lo vuelvas a pasar), pero no se reenvían megabytes en cada
 * mensaje. El archivo no se borra del disco.
 */

import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import type { AiAttachmentPart } from './aiEngine';
import {
  ALLOWED_ATTACHMENT_HINT,
  MAX_ATTACHMENT_BYTES,
  MAX_INLINE_ATTACHMENT_BYTES,
  MAX_TUTOR_ATTACHMENTS,
  isAllowedMime,
  isImageMime,
} from './attachmentLimits';

// Los límites viven en `attachmentLimits.ts` (puro) para que el navegador use
// exactamente los mismos; aquí solo se reexportan por comodidad del servidor.
export {
  ALLOWED_ATTACHMENT_HINT,
  ATTACHMENT_LIVE_TURNS,
  MAX_ATTACHMENT_BYTES,
  MAX_TUTOR_ATTACHMENTS,
  isAllowedMime,
} from './attachmentLimits';

/** Carpeta local de las copias (fuera del control de versiones). */
export const UPLOADS_DIR = path.join(process.cwd(), 'data', 'uploads');

/** Nombre de archivo seguro para la copia local. */
export function safeUploadName(name: string): string {
  const clean = String(name ?? 'adjunto')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > 0 ? clean.slice(0, 120) : 'adjunto';
}

export interface ValidAttachment {
  name: string;
  mimeType: string;
  sizeBytes: number;
  /** Contenido en base64, sin el prefijo `data:`. */
  base64: string;
}

export type AttachmentValidation =
  | { ok: true; attachments: ValidAttachment[] }
  | { ok: false; error: string };

/** Tamaño real de un base64, sin decodificarlo entero. */
function base64Size(base64: string): number {
  const clean = base64.replace(/\s+/g, '');
  if (clean.length === 0) return 0;
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

/** Quita el prefijo `data:image/png;base64,` si el navegador lo incluye. */
function stripDataUrlPrefix(raw: string): string {
  const match = raw.match(/^data:[^;,]*;base64,([\s\S]*)$/);
  return match ? match[1] : raw;
}

/**
 * Valida los adjuntos que llegan del navegador. Es tolerante con la ausencia
 * del campo (no hay adjuntos = lista vacía) y estricto con lo que sí llega.
 */
export function validateAttachments(raw: unknown): AttachmentValidation {
  if (raw === undefined || raw === null) return { ok: true, attachments: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'Los adjuntos no tienen el formato esperado.' };
  }
  if (raw.length === 0) return { ok: true, attachments: [] };
  if (raw.length > MAX_TUTOR_ATTACHMENTS) {
    return {
      ok: false,
      error: `Puedes adjuntar como mucho ${MAX_TUTOR_ATTACHMENTS} archivos por mensaje.`,
    };
  }

  const attachments: ValidAttachment[] = [];

  for (const item of raw) {
    const candidate = (item ?? {}) as { name?: unknown; mimeType?: unknown; data?: unknown };
    const name = typeof candidate.name === 'string' ? candidate.name.trim().slice(0, 160) : '';
    const mimeType = typeof candidate.mimeType === 'string' ? candidate.mimeType.trim().toLowerCase() : '';
    const data = typeof candidate.data === 'string' ? stripDataUrlPrefix(candidate.data).trim() : '';

    if (!name) return { ok: false, error: 'Cada adjunto necesita un nombre de archivo.' };
    if (!isAllowedMime(mimeType)) {
      return { ok: false, error: `No sé leer «${name}» (${mimeType || 'tipo desconocido'}). ${ALLOWED_ATTACHMENT_HINT}` };
    }
    if (!data) return { ok: false, error: `El archivo «${name}» ha llegado vacío.` };

    const sizeBytes = base64Size(data);
    if (sizeBytes > MAX_ATTACHMENT_BYTES) {
      return {
        ok: false,
        error: `«${name}» pesa ${(sizeBytes / (1024 * 1024)).toFixed(1)} MB y el máximo es ${
          MAX_ATTACHMENT_BYTES / (1024 * 1024)
        } MB. Recórtalo o comprímelo.`,
      };
    }

    attachments.push({ name, mimeType, sizeBytes, base64: data });
  }

  return { ok: true, attachments };
}

export interface StoredAttachment {
  name: string;
  mimeType: string;
  sizeBytes: number;
  localPath: string;
}

/**
 * Guarda una copia de cada adjunto en `data/uploads/`. Si el disco falla, el
 * adjunto se devuelve sin copia local: el mensaje se envía igual a la IA y el
 * alumno ve el archivo en el chat, pero no queda reabrible sin conexión.
 */
export async function storeAttachments(attachments: ValidAttachment[]): Promise<StoredAttachment[]> {
  if (attachments.length === 0) return [];

  try {
    await mkdir(UPLOADS_DIR, { recursive: true });
  } catch {
    return attachments.map((attachment) => ({
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      localPath: '',
    }));
  }

  const stored: StoredAttachment[] = [];

  for (const attachment of attachments) {
    let localPath = '';
    try {
      const fileName = `${randomUUID()}-${safeUploadName(attachment.name)}`;
      const absolute = path.join(UPLOADS_DIR, fileName);
      await writeFile(absolute, Buffer.from(attachment.base64, 'base64'));
      localPath = absolute;
    } catch {
      localPath = '';
    }

    stored.push({
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      localPath,
    });
  }

  return stored;
}

/**
 * Reconstruye las partes multimodales de los adjuntos de un turno guardado.
 *
 * Solo entran los que hay que **mirar** (capturas y escaneos) y solo mientras
 * quepan en una petición: el texto de un tema o de un libro se le da al modelo
 * como texto, así que sus bytes no tienen por qué viajar otra vez en cada turno
 * —y un PDF de 30 MB no cabría aunque quisiéramos—.
 */
export async function loadAttachmentParts(
  rows: Array<{ name: string; mimeType: string; localPath: string | null; sizeBytes?: number }>
): Promise<AiAttachmentPart[]> {
  const parts: AiAttachmentPart[] = [];
  let inlineBytes = 0;

  for (const row of rows) {
    if (!row.localPath) continue;
    if (!isImageMime(row.mimeType) && row.mimeType !== 'application/pdf') continue;
    if (typeof row.sizeBytes === 'number' && row.sizeBytes > MAX_INLINE_ATTACHMENT_BYTES) continue;
    if (inlineBytes >= MAX_INLINE_ATTACHMENT_BYTES) break;

    try {
      const data = await readFile(row.localPath);
      if (inlineBytes + data.byteLength > MAX_INLINE_ATTACHMENT_BYTES) continue;
      inlineBytes += data.byteLength;
      parts.push({ name: row.name, mimeType: row.mimeType, data: data.toString('base64') });
    } catch {
      // La copia local ya no está: el turno antiguo se queda sin binario.
    }
  }

  return parts;
}
