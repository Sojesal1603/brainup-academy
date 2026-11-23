/**
 * Persistencia del lienzo modular.
 *
 * Aquí se juntan las tres capas y ninguna decide por su cuenta:
 *   · `citation.ts` dice si una cita es verdad;
 *   · `blocks.ts` dice qué se conserva y hasta dónde se puede anidar;
 *   · `projection.ts` escribe `Note.content`.
 *
 * Regla de oro: **siempre** se actualiza la proyección después de tocar el
 * árbol. Así el resto de la app (visor, descarga, búsqueda) sigue leyendo
 * `Note.content` sin saber que por dentro hay secciones y bloques.
 */

import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
import type { NoteBlockType, QuoteStatus } from '@prisma/client';
import {
  canAddVariant,
  mergeGeneratedBlocks,
  preservedBlockIds,
  sectionStatusAfterExpansion,
  type BlockLike,
} from './blocks';
import { checkCitation, citationCoverage, type CitationChunk } from './citation';
import { projectNoteMarkdown } from './projection';
import { titleCoverage } from './sources';

export type StudyBlock = BlockLike & {
  sectionId: string;
  createdAt?: Date;
  updatedAt?: Date;
};

export interface GeneratedBlockInput {
  type: NoteBlockType;
  content: string;
  chunkId?: string | null;
  quote?: string | null;
}

export interface ValidatedBlock extends GeneratedBlockInput {
  quoteStatus: QuoteStatus;
  /** Motivo del fallo, para el reintento y para la interfaz. */
  citationReason: string | null;
}

/** Apunte con su árbol completo, acotado a la cuenta por `db(userId)`. */
export async function loadNoteTree(userId: string, noteId: string) {
  return db(userId).note.findFirst({
    where: { id: noteId },
    include: {
      topic: { include: { subject: { select: { id: true, name: true } } } },
      agent: { select: { name: true } },
      sections: {
        orderBy: { order: 'asc' },
        include: { blocks: { orderBy: { order: 'asc' } } },
      },
    },
  });
}

export type NoteTree = NonNullable<Awaited<ReturnType<typeof loadNoteTree>>>;

/**
 * Forma JSON que consume el lienzo. Se calcula aquí y no en cada ruta para que
 * la cobertura y los estados significan lo mismo en todas partes.
 */
export function serializeNoteTree(note: NoteTree) {
  const coverage = citationCoverage(
    note.sections.map((section) => ({
      status: section.status,
      blocks: section.blocks.map((block) => ({ quoteStatus: block.quoteStatus })),
    }))
  );

  return {
    id: note.id,
    title: note.title,
    content: note.content,
    updatedAt: note.updatedAt.toISOString(),
    topic: {
      id: note.topic.id,
      title: note.topic.title,
      unitNumber: note.topic.unitNumber,
      subjectName: note.topic.subject.name,
    },
    agentName: note.agent?.name ?? null,
    coverage,
    sections: note.sections.map((section) => ({
      id: section.id,
      title: section.title,
      purpose: section.purpose,
      order: section.order,
      status: section.status,
      pageFrom: section.pageFrom,
      pageTo: section.pageTo,
      coverage: section.coverage,
      blocks: section.blocks.map((block) => ({
        id: block.id,
        parentId: block.parentId,
        order: block.order,
        type: block.type,
        content: block.content,
        isAiGenerated: block.isAiGenerated,
        isEdited: block.isEdited,
        chunkId: block.chunkId,
        quote: block.quote,
        quoteStatus: block.quoteStatus,
      })),
    })),
  };
}

/** Proyección actual del árbol, sin escribir nada. */
export function projectionOf(note: NoteTree): string {
  return projectNoteMarkdown({
    title: note.title,
    sections: note.sections.map((section) => ({
      id: section.id,
      title: section.title,
      purpose: section.purpose,
      order: section.order,
      status: section.status,
      pageFrom: section.pageFrom,
      pageTo: section.pageTo,
      blocks: section.blocks.map((block) => ({
        id: block.id,
        parentId: block.parentId,
        order: block.order,
        type: block.type,
        content: block.content,
        quoteStatus: block.quoteStatus,
      })),
    })),
  });
}

/**
 * Escribe `Note.content` como proyección del árbol. Devuelve el Markdown
 * resultante o `null` si el apunte ya no existe.
 */
export async function saveNoteProjection(userId: string, noteId: string): Promise<string | null> {
  const note = await loadNoteTree(userId, noteId);
  if (!note) return null;

  const markdown = projectionOf(note);
  await db(userId).note.update({
    where: { id: noteId },
    data: { content: markdown },
  });
  return markdown;
}

/**
 * Valida un lote de bloques generados contra los trozos permitidos.
 *
 * No reintenta aquí (eso necesita al modelo): devuelve el estado de cada cita
 * para que la ruta decida si pide una corrección o si guarda con aviso.
 */
export function validateGeneratedBlocks(params: {
  userId: string;
  blocks: readonly GeneratedBlockInput[];
  allowed: ReadonlyMap<string, CitationChunk>;
}): ValidatedBlock[] {
  return params.blocks.map((block) => {
    const hasCitation = Boolean(block.chunkId || block.quote);

    if (!hasCitation) {
      if (block.type === 'EVIDENCE') {
        return {
          ...block,
          quoteStatus: 'ERROR',
          citationReason: 'Un bloque de cita necesita `chunkId` y `quote`.',
        };
      }
      return { ...block, quoteStatus: 'NONE', citationReason: null };
    }

    const check = checkCitation({
      userId: params.userId,
      chunkId: block.chunkId,
      quote: block.quote,
      allowed: params.allowed,
    });

    return { ...block, quoteStatus: check.status, citationReason: check.reason };
  });
}

export interface SectionGenerationResult {
  kept: number;
  added: number;
  discarded: number;
  verified: number;
  unverified: number;
  errors: number;
  blocks: Array<{
    id: string;
    type: string;
    content: string;
    quoteStatus: string;
    citationReason: string | null;
  }>;
  status: 'COMPLETED' | 'PENDING';
  markdown: string;
}

/**
 * Guarda el desarrollo de una sección.
 *
 * Los bloques editados (y sus padres) se conservan; el resto de la generación
 * anterior se sustituye. Un bloque con cita no verificada **se guarda con su
 * estado**, nunca como VERIFIED: la interfaz lo enseña para revisión.
 */
export async function persistSectionGeneration(params: {
  userId: string;
  noteId: string;
  sectionId: string;
  blocks: readonly ValidatedBlock[];
}): Promise<SectionGenerationResult> {
  const prisma = db(params.userId);
  const note = await loadNoteTree(params.userId, params.noteId);
  if (!note) throw new Error('El apunte ya no está en el cuaderno.');

  const section = note.sections.find((item) => item.id === params.sectionId);
  if (!section) throw new Error('Ese apartado ya no está en el apunte.');

  const existing = section.blocks as unknown as StudyBlock[];
  const preserveIds = preservedBlockIds(existing);

  const generated = params.blocks.map((block, index) => ({
    id: randomUUID(),
    sectionId: params.sectionId,
    parentId: null as string | null,
    order: index,
    type: block.type,
    content: block.content,
    isEdited: false,
    isAiGenerated: true,
    chunkId: block.chunkId ?? null,
    quote: block.quote ?? null,
    quoteStatus: block.quoteStatus,
    citationReason: block.citationReason,
  }));

  const merge = mergeGeneratedBlocks(existing, generated, { preserveIds });

  // Órdenes finales: primero lo conservado (con su orden original) y después
  // lo nuevo. El orden de la proyección es el único que ve el alumno.
  const maxKeptOrder = merge.kept.reduce((max, block) => Math.max(max, block.order), -1);
  const additions = merge.added.map((block, index) => ({
    ...block,
    order: maxKeptOrder + 1 + index,
  }));

  const keepIds = new Set(merge.kept.map((block) => block.id));
  const toDelete = existing.filter((block) => !keepIds.has(block.id)).map((block) => block.id);

  if (toDelete.length > 0) {
    await prisma.noteBlock.deleteMany({ where: { id: { in: toDelete }, isEdited: false } });
  }

  if (additions.length > 0) {
    await prisma.noteBlock.createMany({
      data: additions.map((block) => ({
        id: block.id,
        userId: params.userId,
        noteId: params.noteId,
        sectionId: params.sectionId,
        parentId: null,
        type: block.type as NoteBlockType,
        content: block.content,
        order: block.order,
        isAiGenerated: true,
        isEdited: false,
        chunkId: block.chunkId,
        quote: block.quote,
        quoteStatus: block.quoteStatus as QuoteStatus,
      })),
    });
  }

  const finalBlocks = [...merge.kept, ...additions];
  const status = sectionStatusAfterExpansion(finalBlocks);

  await prisma.noteSection.update({
    where: { id: params.sectionId },
    data: { status },
  });

  const markdown = (await saveNoteProjection(params.userId, params.noteId)) ?? '';

  return {
    kept: merge.kept.length,
    added: additions.length,
    discarded: merge.discarded,
    verified: finalBlocks.filter((block) => block.quoteStatus === 'VERIFIED').length,
    unverified: finalBlocks.filter((block) => block.quoteStatus === 'UNVERIFIED').length,
    errors: finalBlocks.filter((block) => block.quoteStatus === 'ERROR').length,
    blocks: finalBlocks.map((block) => ({
      id: block.id,
      type: block.type,
      content: block.content,
      quoteStatus: block.quoteStatus,
      citationReason:
        (block as { citationReason?: string | null }).citationReason ?? null,
    })),
    status,
    markdown,
  };
}

/** Crea los apartados de un esquema (solo si el apunte aún no tiene árbol). */
export async function createOutlineSections(params: {
  userId: string;
  noteId: string;
  sections: ReadonlyArray<{
    title: string;
    purpose: string;
    pageFrom?: number | null;
    pageTo?: number | null;
  }>;
  chunks: ReadonlyArray<{ text: string }>;
}): Promise<{ created: boolean; count: number }> {
  const prisma = db(params.userId);
  const note = await prisma.note.findFirst({
    where: { id: params.noteId },
    include: { sections: { select: { id: true } } },
  });
  if (!note) throw new Error('El apunte ya no está en el cuaderno.');
  if (note.sections.length > 0) return { created: false, count: note.sections.length };

  let order = 0;
  for (const section of params.sections) {
    await prisma.noteSection.create({
      data: {
        userId: params.userId,
        noteId: params.noteId,
        title: section.title,
        purpose: section.purpose,
        order,
        status: 'PENDING',
        pageFrom: section.pageFrom ?? null,
        pageTo: section.pageTo ?? null,
        coverage: titleCoverage(section.title, params.chunks),
      },
    });
    order += 1;
  }

  await saveNoteProjection(params.userId, params.noteId);
  return { created: true, count: order };
}

/** Añade una variante hija («más sencillo», «un ejemplo», «más profundo»). */
export async function addBlockVariant(params: {
  userId: string;
  noteId: string;
  parentId: string;
  block: ValidatedBlock;
}): Promise<{ id: string; depth: number; markdown: string }> {
  const prisma = db(params.userId);
  const note = await loadNoteTree(params.userId, params.noteId);
  if (!note) throw new Error('El apunte ya no está en el cuaderno.');

  const all = note.sections.flatMap((section) => section.blocks) as unknown as StudyBlock[];
  const parent = all.find((block) => block.id === params.parentId);
  if (!parent) throw new Error('Ese bloque ya no está en el apunte.');

  const byId = new Map(all.map((block) => [block.id, block]));
  const allowed = canAddVariant(params.parentId, byId);
  if (!allowed.ok) throw new Error(allowed.reason);

  const siblings = all.filter((block) => block.parentId === params.parentId);
  const order = siblings.reduce((max, block) => Math.max(max, block.order), -1) + 1;

  const created = await prisma.noteBlock.create({
    data: {
      userId: params.userId,
      noteId: params.noteId,
      sectionId: parent.sectionId,
      parentId: params.parentId,
      type: params.block.type,
      content: params.block.content,
      order,
      isAiGenerated: true,
      isEdited: false,
      chunkId: params.block.chunkId ?? null,
      quote: params.block.quote ?? null,
      quoteStatus: params.block.quoteStatus,
    },
  });

  const markdown = (await saveNoteProjection(params.userId, params.noteId)) ?? '';

  // La profundidad del nuevo bloque es la del padre + 1.
  const depth = ((): number => {
    let value = 0;
    let current = created.parentId;
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      seen.add(current);
      value += 1;
      current = byId.get(current)?.parentId ?? null;
    }
    return value;
  })();

  return { id: created.id, depth, markdown };
}

/** Guarda una edición del alumno. A partir de aquí la IA no la sobrescribe. */
export async function updateBlockContent(params: {
  userId: string;
  noteId: string;
  blockId: string;
  content: string;
}): Promise<{ markdown: string }> {
  const content = String(params.content ?? '').trim();
  if (content.length === 0) throw new Error('Un bloque no puede quedarse vacío.');

  const updated = await db(params.userId).noteBlock.updateMany({
    where: { id: params.blockId, noteId: params.noteId },
    data: { content, isEdited: true, isAiGenerated: false },
  });
  if (updated.count === 0) throw new Error('Ese bloque ya no está en el apunte.');

  const markdown = (await saveNoteProjection(params.userId, params.noteId)) ?? '';
  return { markdown };
}

/** Marca un apartado como omitido (o lo devuelve a pendiente). */
export async function setSectionStatus(params: {
  userId: string;
  noteId: string;
  sectionId: string;
  status: 'PENDING' | 'SKIPPED';
}): Promise<{ markdown: string }> {
  const updated = await db(params.userId).noteSection.updateMany({
    where: { id: params.sectionId, noteId: params.noteId },
    data: { status: params.status },
  });
  if (updated.count === 0) throw new Error('Ese apartado ya no está en el apunte.');

  const markdown = (await saveNoteProjection(params.userId, params.noteId)) ?? '';
  return { markdown };
}

/**
 * Reordena los apartados. El índice único `(noteId, order)` obliga a pasar por
 * valores temporales: si no, el primer update choca con el orden que aún tiene
 * otro apartado.
 */
export async function reorderSections(params: {
  userId: string;
  noteId: string;
  sectionIds: readonly string[];
}): Promise<{ markdown: string }> {
  const prisma = db(params.userId);
  const note = await prisma.note.findFirst({
    where: { id: params.noteId },
    include: { sections: { select: { id: true } } },
  });
  if (!note) throw new Error('El apunte ya no está en el cuaderno.');

  const known = new Set(note.sections.map((section) => section.id));
  if (params.sectionIds.length !== known.size) {
    throw new Error('La lista de apartados no coincide con el apunte.');
  }
  for (const id of params.sectionIds) {
    if (!known.has(id)) throw new Error('Hay un apartado que no pertenece a este apunte.');
  }

  for (let index = 0; index < params.sectionIds.length; index += 1) {
    await prisma.noteSection.update({
      where: { id: params.sectionIds[index] },
      data: { order: -(index + 1) },
    });
  }
  for (let index = 0; index < params.sectionIds.length; index += 1) {
    await prisma.noteSection.update({
      where: { id: params.sectionIds[index] },
      data: { order: index },
    });
  }

  const markdown = (await saveNoteProjection(params.userId, params.noteId)) ?? '';
  return { markdown };
}
