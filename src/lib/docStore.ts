/**
 * Los documentos que le das al catedrático: se guardan **según llegan**.
 *
 * El problema que resuelve esto: antes un adjunto viajaba en base64 dentro del
 * JSON del chat, así que un archivo de 300 MB había que montarlo entero en la
 * memoria del navegador (y del servidor) — y por eso había un tope de 6 MB que
 * dejaba fuera justo el material de estudio de verdad. Ahora el archivo entra
 * por su propia puerta en **crudo y en streaming**: se escribe en disco mientras
 * se descarga, sin pasar por memoria, y el tope es solo de sensatez.
 *
 * Cada subida deja cuatro cosas en `data/uploads/`:
 *
 *   - `<id>.bin`  → el archivo tal cual, para poder reabrirlo y para mirarlo
 *                   cuando hay que **verlo** (una captura, un PDF escaneado).
 *   - `<id>.txt`  → el texto extraído, si el documento tiene texto.
 *   - `<id>.index.json` → el índice troceado (lo que lee el catedrático).
 *   - `<id>.json` → los datos de la subida (nombre, tipo, peso, páginas, avisos).
 *
 * El texto va en su propio fichero y **no** dentro del JSON a propósito: un libro
 * son megas de texto y el índice se reescribe; mezclarlos haría lento cada turno.
 */

import { createWriteStream } from 'fs';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import {
  ALLOWED_ATTACHMENT_HINT,
  formatBytes,
  kindOfMime,
  resolveMimeType,
  type AttachmentKind,
} from './attachmentLimits';
import { readDocument, type DocReadMode } from './docRead';
import { buildDocumentIndex, type IndexedDoc } from './docContext';

/** Carpeta local de las subidas (fuera del control de versiones). */
export const UPLOADS_DIR = path.join(process.cwd(), 'data', 'uploads');

export interface StoredUpload {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  kind: AttachmentKind;
  /** Ruta absoluta del binario: `<id>.bin`. */
  path: string;
  createdAt: string;
  /** Cómo se ha podido leer: texto, solo imagen, o sin texto (escaneo sin capa). */
  mode: DocReadMode;
  pages: number;
  chars: number;
  /** Avisos honestos para el alumno («12 páginas sin texto: son escaneos»). */
  notes: string[];
  /** `null` cuando el archivo es una imagen (no hay texto que indexar). */
  index: IndexedDoc | null;
}

/**
 * `code` es una extensión pequeña del contrato: la ruta necesita distinguir
 * «pesa demasiado» (413) de «no sé leer ese tipo» (400) sin adivinar por el
 * texto del mensaje.
 */
export type UploadResult =
  | { ok: true; upload: StoredUpload; code?: undefined }
  | { ok: false; error: string; code?: 'too_big' | 'tipo' | 'vacio' | 'disco' };

/**
 * Un id solo puede ser un UUID: lo que llega por la barra de direcciones no
 * puede convertirse en una ruta del disco (`../../algo`).
 */
function isSafeId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id ?? ''));
}

function binPath(id: string): string {
  return path.join(UPLOADS_DIR, `${id}.bin`);
}
function textPath(id: string): string {
  return path.join(UPLOADS_DIR, `${id}.txt`);
}
function indexPath(id: string): string {
  return path.join(UPLOADS_DIR, `${id}.index.json`);
}
function metaPath(id: string): string {
  return path.join(UPLOADS_DIR, `${id}.json`);
}

/** Nombre de archivo seguro, solo para el `Content-Disposition` y los mensajes. */
export function safeUploadName(name: string): string {
  const clean = String(name ?? 'adjunto')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > 0 ? clean.slice(0, 160) : 'adjunto';
}

/**
 * Escribe el stream en disco contando los bytes: si se pasa del tope, corta en
 * ese mismo instante y borra el trozo escrito. Así un archivo enorme no llena el
 * disco ni la memoria, y el alumno sabe exactamente qué pasó.
 */
async function writeStreamWithLimit(
  stream: ReadableStream<Uint8Array>,
  target: string,
  maxBytes: number
): Promise<{ ok: true; bytes: number } | { ok: false; error: string; code: 'too_big' | 'disco' }> {
  let bytes = 0;
  let exceeded = false;

  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        exceeded = true;
        callback(new Error('ARCHIVO_DEMASIADO_GRANDE'));
        return;
      }
      callback(null, chunk);
    },
  });

  const out = createWriteStream(target);

  try {
    await pipeline(Readable.fromWeb(stream as Parameters<typeof Readable.fromWeb>[0]), counter, out);
  } catch {
    // El trozo escrito no sirve para nada: no se deja basura en la carpeta.
    await rm(target, { force: true }).catch(() => {});
    if (exceeded) {
      return {
        ok: false,
        code: 'too_big',
        error: `El archivo pesa más de ${formatBytes(maxBytes)}, que es el tope.`,
      };
    }
    return { ok: false, code: 'disco', error: 'No se ha podido guardar el archivo en el disco del equipo.' };
  }

  return { ok: true, bytes };
}

/**
 * Guarda una subida y la deja lista para leer: escribe el binario en streaming,
 * extrae el texto y construye el índice.
 *
 * Un fallo del extractor **nunca** pierde el archivo: se guarda igual, con el
 * modo honesto (`sin_texto` + el aviso explicando por qué).
 */
export async function saveUploadFromStream(
  stream: ReadableStream<Uint8Array>,
  params: { name: string; mimeType: string; maxBytes: number }
): Promise<UploadResult> {
  const name = safeUploadName(params.name);

  // El tipo real: lo que dice el navegador o, si no dice nada útil, la extensión.
  const mimeType = resolveMimeType(name, params.mimeType);
  if (!mimeType) {
    return {
      ok: false,
      code: 'tipo',
      error: `No sé leer «${name}». ${ALLOWED_ATTACHMENT_HINT}`,
    };
  }

  const kind = kindOfMime(mimeType);
  const id = randomUUID();

  try {
    await mkdir(UPLOADS_DIR, { recursive: true });
  } catch {
    return { ok: false, code: 'disco', error: 'No se ha podido preparar la carpeta de subidas.' };
  }

  const written = await writeStreamWithLimit(stream, binPath(id), params.maxBytes);
  if (!written.ok) return { ok: false, code: written.code, error: written.error };

  if (written.bytes === 0) {
    await rm(binPath(id), { force: true }).catch(() => {});
    return { ok: false, code: 'vacio', error: `El archivo «${name}» ha llegado vacío.` };
  }

  // Lectura del contenido: es lo que convierte «un PDF de 200 MB» en algo que el
  // catedrático puede leer de verdad.
  let mode: DocReadMode = kind === 'imagen' ? 'imagen' : 'texto';
  let text = '';
  let pages = 0;
  let chars = 0;
  const notes: string[] = [];

  if (kind === 'imagen') {
    // Una captura no tiene texto: se mira.
    notes.push('Es una imagen: el catedrático la mira directamente.');
  } else {
    try {
      const read = await readDocument({ path: binPath(id), mimeType, name });
      mode = read.mode;
      text = read.text;
      pages = read.pages;
      chars = read.chars;
      notes.push(...read.notes);
    } catch (error) {
      mode = 'sin_texto';
      notes.push(
        `No he podido sacarle el texto a este archivo (${
          error instanceof Error ? error.message.slice(0, 120) : 'error desconocido'
        }). Se queda guardado y el catedrático puede mirarlo, pero no he leído su contenido.`
      );
    }
  }

  // El índice es lo que se consulta en cada pregunta: se construye una sola vez,
  // al subir, y no en cada turno de chat.
  let index: IndexedDoc | null = null;
  if (text.trim().length > 0) {
    try {
      index = buildDocumentIndex({ id, name, text, pages, mode });
      await writeFile(textPath(id), text, 'utf8');
      await writeFile(indexPath(id), JSON.stringify(index), 'utf8');
    } catch {
      index = null;
      notes.push('El texto se ha leído, pero no se ha podido preparar su índice: se buscará en el documento entero.');
    }
  }

  const upload: StoredUpload = {
    id,
    name,
    mimeType,
    sizeBytes: written.bytes,
    kind,
    path: binPath(id),
    createdAt: new Date().toISOString(),
    mode,
    pages,
    chars,
    notes,
    index,
  };

  try {
    // El índice viaja en su propio fichero; en el metadato no se duplica (sería
    // copiar megas de texto en cada subida).
    const meta = {
      id: upload.id,
      name: upload.name,
      mimeType: upload.mimeType,
      sizeBytes: upload.sizeBytes,
      kind: upload.kind,
      path: upload.path,
      createdAt: upload.createdAt,
      mode: upload.mode,
      pages: upload.pages,
      chars: upload.chars,
      notes: upload.notes,
    };
    await writeFile(metaPath(id), JSON.stringify(meta), 'utf8');
  } catch {
    return { ok: false, code: 'disco', error: 'El archivo se ha subido, pero no se ha podido anotar en el índice de subidas.' };
  }

  return { ok: true, upload };
}

/** Los datos de una subida (con su índice), o `null` si ya no está. */
export async function readUpload(id: string): Promise<StoredUpload | null> {
  if (!isSafeId(id)) return null;

  let meta: Omit<StoredUpload, 'index'>;
  try {
    meta = JSON.parse(await readFile(metaPath(id), 'utf8')) as Omit<StoredUpload, 'index'>;
  } catch {
    return null;
  }

  let index: IndexedDoc | null = null;
  try {
    index = JSON.parse(await readFile(indexPath(id), 'utf8')) as IndexedDoc;
  } catch {
    // Sin índice (o ilegible): el documento sigue estando, solo se puede leer
    // peor. Se dice tal cual en vez de fingir que no existe.
    index = null;
  }

  return { ...meta, index };
}

/** El texto extraído de una subida, o `null` si no tiene capa de texto. */
export async function readUploadText(id: string): Promise<string | null> {
  if (!isSafeId(id)) return null;
  try {
    const text = await readFile(textPath(id), 'utf8');
    return text.trim().length > 0 ? text : null;
  } catch {
    return null;
  }
}

/** El binario de una subida (para mirarlo o para servirlo de vuelta). */
export async function readUploadBytes(id: string): Promise<Buffer | null> {
  if (!isSafeId(id)) return null;
  try {
    return await readFile(binPath(id));
  } catch {
    return null;
  }
}

/** Borra una subida y todo lo que trajo consigo. Devuelve si había algo que borrar. */
export async function deleteUpload(id: string): Promise<boolean> {
  if (!isSafeId(id)) return false;

  let existed = false;
  try {
    await readFile(metaPath(id));
    existed = true;
  } catch {
    existed = false;
  }

  await Promise.all([
    rm(binPath(id), { force: true }).catch(() => {}),
    rm(textPath(id), { force: true }).catch(() => {}),
    rm(indexPath(id), { force: true }).catch(() => {}),
    rm(metaPath(id), { force: true }).catch(() => {}),
  ]);

  return existed;
}
