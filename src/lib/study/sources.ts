/**
 * Fuentes persistentes: de un archivo en disco temporal a filas citables.
 *
 * El flujo es idempotente por contenido (`sha256` por cuenta):
 *
 *   bytes → sha256 → ¿ya existe? → sí: se reutiliza (no se paga dos veces)
 *                                → no: extraer → trocear → guardar en el
 *                                      almacén de objetos → crear filas
 *
 * La extracción y el troceado son los que ya usa el catedrático (`docRead` y
 * `chunkDocument`): no hay dos formas de leer un PDF en la app.
 *
 * El binario y el texto van al almacén **antes** de crear las filas. Si el
 * almacén falla, no se crea una fuente «fantasma» que luego no se puede citar.
 */

import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { db } from '@/lib/db';
import { DocumentPageLimitError, readDocument } from '@/lib/docRead';
import { chunkDocument, rankChunks, type DocChunk, type IndexedDoc } from '@/lib/docContext';
import { MAX_ATTACHMENT_BYTES, resolveMimeType } from '@/lib/attachmentLimits';
import { buildObjectKey, putObject } from '@/lib/storage/objectStore';
import type { SourceKind } from '@prisma/client';
import type { PromptChunk } from './prompts';

export const MAX_SOURCE_BYTES = MAX_ATTACHMENT_BYTES;

/** La fuente no se ha podido guardar en el almacén: es un 503, no un 400. */
export class SourceStorageError extends Error {
  readonly code = 'SOURCE_STORAGE';
}

/** Lo que se puede leer del archivo no permite citar (escaneo sin texto). */
export class SourceTextError extends Error {
  readonly code = 'SOURCE_TEXT';
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sourceKindOf(mimeType: string): SourceKind {
  const mime = String(mimeType ?? '').toLowerCase();
  if (mime === 'application/pdf') return 'PDF';
  if (mime.includes('wordprocessingml')) return 'DOCX';
  if (mime.includes('presentationml')) return 'PPTX';
  if (mime.includes('spreadsheetml')) return 'XLSX';
  if (mime.includes('opendocument.text')) return 'ODT';
  if (mime.startsWith('image/')) return 'IMAGE';
  if (mime.startsWith('text/')) return 'TEXT';
  return 'OTHER';
}

function extensionOf(name: string, mimeType: string): string {
  const fromName = path.extname(name).replace(/^\./, '').toLowerCase();
  if (fromName.length > 0 && fromName.length <= 8) return fromName;
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType.startsWith('image/')) return mimeType.split('/')[1] ?? 'img';
  return 'bin';
}

export interface IngestSourceParams {
  userId: string;
  /** Ruta local temporal del archivo ya subido (se borra fuera de aquí). */
  filePath: string;
  name: string;
  mimeType: string;
  title?: string;
  subjectId?: string | null;
  topicId?: string | null;
}

export interface IngestedSource {
  id: string;
  title: string;
  pages: number;
  chars: number;
  chunks: number;
  status: string;
  deduplicated: boolean;
  notes: string[];
}

/**
 * Ingesta una fuente. Devuelve la fila existente si el mismo contenido ya se
 * había subido en esta cuenta.
 */
export async function ingestSource(params: IngestSourceParams): Promise<IngestedSource> {
  const bytes = await readFile(params.filePath);
  if (bytes.byteLength === 0) throw new SourceTextError('El archivo ha llegado vacío.');
  if (bytes.byteLength > MAX_SOURCE_BYTES) {
    throw new SourceTextError(
      `El archivo pesa más de ${Math.round(MAX_SOURCE_BYTES / (1024 * 1024))} MB, que es el tope.`
    );
  }

  const sha256 = sha256Hex(bytes);
  const prisma = db(params.userId);

  // Deduplicación por contenido, no por nombre: el mismo PDF subido dos veces
  // con nombres distintos es la misma fuente.
  const existing = await prisma.sourceDocument.findFirst({
    where: { sha256 },
    include: { chunks: { select: { id: true } } },
  });
  if (existing) {
    return {
      id: existing.id,
      title: existing.title,
      pages: existing.pages,
      chars: existing.chars,
      chunks: existing.chunks.length,
      status: existing.status,
      deduplicated: true,
      notes: [],
    };
  }

  const mimeType = resolveMimeType(params.name, params.mimeType) ?? params.mimeType;
  const name = String(params.name ?? 'documento').slice(0, 200);
  const title = String(params.title ?? '').trim() || name.replace(/\.[^.]+$/, '').slice(0, 200);
  const id = randomUUID();
  const ext = extensionOf(name, mimeType);

  const storageKey = buildObjectKey(params.userId, `sources/${id}`, `original.${ext}`);
  const textKey = buildObjectKey(params.userId, `sources/${id}`, 'text.txt');

  // El binario se guarda primero: si esto falla, no hay fila a medias.
  try {
    await putObject({
      userId: params.userId,
      key: storageKey,
      body: bytes,
      contentType: mimeType,
    });
  } catch (error) {
    throw new SourceStorageError(
      `No se ha podido guardar la fuente en el almacén: ${
        error instanceof Error ? error.message : 'error desconocido'
      }`
    );
  }

  let text = '';
  let pages = 0;
  let chars = 0;
  let mode = 'texto';
  const notes: string[] = [];

  try {
    const read = await readDocument({ path: params.filePath, mimeType, name });
    text = read.text;
    pages = read.pages;
    chars = read.chars;
    mode = read.mode;
    notes.push(...read.notes);
  } catch (error) {
    if (error instanceof DocumentPageLimitError) {
      throw new SourceTextError(error.message);
    }
    mode = 'sin_texto';
    notes.push(
      `No se ha podido extraer el texto (${
        error instanceof Error ? error.message.slice(0, 120) : 'error desconocido'
      }). La fuente queda guardada, pero no se puede citar.`
    );
  }

  const docChunks: DocChunk[] = text.trim().length > 0 ? chunkDocument(text) : [];

  if (text.trim().length > 0) {
    await putObject({
      userId: params.userId,
      key: textKey,
      body: Buffer.from(text, 'utf8'),
      contentType: 'text/plain; charset=utf-8',
    });
  }

  const created = await prisma.sourceDocument.create({
    data: {
      id,
      userId: params.userId,
      title,
      kind: sourceKindOf(mimeType),
      mimeType,
      sizeBytes: bytes.byteLength,
      pages,
      chars,
      sha256,
      storageKey,
      textKey: text.trim().length > 0 ? textKey : null,
      subjectId: params.subjectId ?? null,
      topicId: params.topicId ?? null,
      status: docChunks.length > 0 ? 'READY' : 'FAILED',
      mode,
      notesJson: JSON.stringify(notes),
      error:
        docChunks.length > 0
          ? null
          : 'El documento no tiene capa de texto: se puede guardar, pero no citar.',
    },
  });

  if (docChunks.length > 0) {
    // `createMany` con el dueño inyectado por `db()`: las filas hijas nunca
    // nacen en otra cuenta aunque el llamador se equivoque.
    await prisma.documentChunk.createMany({
      data: docChunks.map((chunk) => ({
        documentId: created.id,
        userId: params.userId,
        order: chunk.index,
        pageFrom: chunk.pageFrom ?? chunk.page ?? null,
        pageTo: chunk.pageTo ?? chunk.page ?? null,
        label: chunk.label.slice(0, 300),
        text: chunk.text,
        charCount: chunk.text.length,
      })),
    });
  }

  return {
    id: created.id,
    title: created.title,
    pages,
    chars,
    chunks: docChunks.length,
    status: created.status,
    deduplicated: false,
    notes,
  };
}

/** Lista de fuentes de la cuenta (sin el texto: eso se pide al citar). */
export async function listSources(userId: string) {
  return db(userId).sourceDocument.findMany({
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      title: true,
      kind: true,
      pages: true,
      chars: true,
      status: true,
      mode: true,
      subjectId: true,
      topicId: true,
      createdAt: true,
      _count: { select: { chunks: true } },
    },
  });
}

export interface SourceContext {
  chunks: PromptChunk[];
  /** Mapa para el validador: un `chunkId` fuera de aquí no se acepta. */
  allowed: Map<string, { id: string; userId: string; text: string }>;
  documents: Array<{ id: string; title: string }>;
}

/**
 * Trozos de las fuentes de una unidad (o asignatura, o de toda la cuenta),
 * ordenados por relevancia léxica con el mismo motor del catedrático.
 *
 * Sin embeddings todavía: esto es la capa léxica determinista. El modo híbrido
 * de la fase 2 se suma aquí sin cambiar a los llamadores.
 */
export async function selectSourceContext(params: {
  userId: string;
  topicId?: string | null;
  subjectId?: string | null;
  query: string;
  budgetChars: number;
  maxChunks?: number;
}): Promise<SourceContext> {
  const where: Record<string, unknown> = { status: 'READY' };
  if (params.topicId) where.topicId = params.topicId;
  else if (params.subjectId) where.subjectId = params.subjectId;

  const documents = await db(params.userId).sourceDocument.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 12,
    include: {
      chunks: {
        orderBy: { order: 'asc' },
        take: 600,
        select: { id: true, label: true, text: true, pageFrom: true, pageTo: true, order: true },
      },
    },
  });

  const allowed = new Map<string, { id: string; userId: string; text: string }>();
  const selected: PromptChunk[] = [];
  let budget = Math.max(0, params.budgetChars);
  const perDoc = documents.length > 0 ? Math.floor(budget / documents.length) : 0;

  for (const document of documents) {
    if (budget <= 0) break;
    if (params.maxChunks && selected.length >= params.maxChunks) break;

    const index: IndexedDoc = {
      id: document.id,
      name: document.title,
      mode: document.mode,
      pages: document.pages,
      chars: document.chars,
      title: document.title,
      chunks: document.chunks.map((chunk) => ({
        index: chunk.order,
        page: chunk.pageFrom,
        pageFrom: chunk.pageFrom,
        pageTo: chunk.pageTo,
        label: chunk.label,
        text: chunk.text,
      })),
    };

    // Reutiliza el ranking del tutor. Sin términos en la consulta (un esquema)
    // se lee en orden de documento, que es lo que el alumno espera.
    const ranked = params.query.trim().length > 0 ? rankChunks(index, params.query) : null;
    const positionOf = new Map<number, number>();
    ranked?.forEach((item, position) => positionOf.set(item.chunk.index, position));

    const ordered = document.chunks.slice().sort((a, b) => {
      if (positionOf.size > 0) {
        return (positionOf.get(a.order) ?? Number.MAX_SAFE_INTEGER) -
          (positionOf.get(b.order) ?? Number.MAX_SAFE_INTEGER);
      }
      return a.order - b.order;
    });

    let docBudget = perDoc > 0 ? perDoc : budget;
    for (const chunk of ordered) {
      const take = Math.min(docBudget, budget, chunk.text.length);
      if (take < 80) break;

      selected.push({
        id: chunk.id,
        label: chunk.label,
        pageFrom: chunk.pageFrom,
        pageTo: chunk.pageTo,
        text: chunk.text.slice(0, take),
      });
      allowed.set(chunk.id, { id: chunk.id, userId: params.userId, text: chunk.text });
      budget -= take;
      docBudget -= take;
      if (params.maxChunks && selected.length >= params.maxChunks) break;
    }
  }

  return {
    chunks: selected,
    allowed,
    documents: documents.map((document) => ({ id: document.id, title: document.title })),
  };
}

/**
 * Cobertura inicial de un apartado: qué parte de sus palabras clave aparece en
 * los trozos disponibles. Es una estimación honesta (0-1), no una promesa.
 */
export function titleCoverage(title: string, chunks: ReadonlyArray<{ text: string }>): number {
  const words = new Set(
    String(title ?? '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .split(/[^a-z0-9áéíóúñ]+/i)
      .filter((word) => word.length >= 4)
  );
  if (words.size === 0) return 0;

  const haystack = chunks
    .map((chunk) => chunk.text)
    .join(' ')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  let found = 0;
  for (const word of words) if (haystack.includes(word)) found += 1;
  return Math.round((found / words.size) * 100) / 100;
}
