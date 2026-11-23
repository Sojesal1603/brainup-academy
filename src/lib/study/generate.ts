/**
 * Orquestación de IA del lienzo: esquema, sección y variantes.
 *
 * Nada de esto decide credenciales: la ruta llama antes a `ensureAiAccess` y
 * `activateAiCredentials` (la misma puerta que el tutor). Aquí solo se compone
 * el prompt, se parsea el JSON y se valida la cita.
 *
 * El reintento es **uno**: si la segunda respuesta tampoco pasa el validador,
 * se guarda con el estado real (UNVERIFIED/ERROR) para que el alumno lo vea.
 * Reintentar hasta que «suene bien» es cómo se fabrican alucinaciones caras.
 */

import { runAiText } from '@/lib/aiEngine';
import type { NoteSectionStatus } from '@prisma/client';
import { checkCitation, citationRetryInstruction, type CitationChunk } from './citation';
import { VARIANT_KINDS, type VariantKind } from './blocks';
import {
  extractJsonObject,
  fallbackOutline,
  outlineSchema,
  schemaIssue,
  sectionSchema,
  variantSchema,
  buildOutlinePrompt,
  buildSectionPrompt,
  buildVariantPrompt,
  packPromptChunks,
  type OutlinePayload,
  type PromptChunk,
} from './prompts';
import {
  persistSectionGeneration,
  validateGeneratedBlocks,
  type GeneratedBlockInput,
  type SectionGenerationResult,
} from './notes';
import { selectSourceContext, type SourceContext } from './sources';

/** La respuesta del modelo no tiene el formato pedido tras el reintento. */
export class StudyFormatError extends Error {
  readonly code = 'STUDY_FORMAT';
}

export interface OutlineResult {
  sections: OutlinePayload['sections'];
  model: string | null;
  provider: string | null;
  fallback: boolean;
  warning: string | null;
  context: SourceContext;
}

function outlineFallback(context: SourceContext, warning: string): OutlineResult {
  return {
    sections: fallbackOutline(
      context.chunks.map((chunk) => ({
        label: chunk.label || `Fragmento ${chunk.pageFrom ?? ''}`.trim(),
        pageFrom: chunk.pageFrom,
        pageTo: chunk.pageTo,
      }))
    ).sections,
    model: null,
    provider: null,
    fallback: true,
    warning,
    context,
  };
}

/**
 * Genera el esquema en segundos. Si no hay fuentes indexadas o el modelo no
 * devuelve JSON válido, cae al esquema por etiquetas en vez de dejar la pantalla
 * vacía: es peor, pero es honesto y se puede editar.
 */
export async function generateOutlineForNote(params: {
  userId: string;
  note: {
    title: string;
    topicId: string;
    topic: { id: string; title: string; unitNumber: number | null; teacherMethod: string | null };
    subject: { id: string; name: string };
  };
}): Promise<OutlineResult> {
  const context = await selectSourceContext({
    userId: params.userId,
    topicId: params.note.topicId,
    subjectId: params.note.subject.id,
    query: `${params.note.topic.title} ${params.note.title}`,
    budgetChars: 30_000,
    maxChunks: 24,
  });

  if (context.chunks.length === 0) {
    return outlineFallback(
      context,
      'No hay fuentes con texto para esta unidad. Sube material y vuelve a generar el esquema.'
    );
  }

  const chunks = packPromptChunks(context.chunks);
  const prompt = buildOutlinePrompt({
    subjectName: params.note.subject.name,
    topicTitle: params.note.topic.title,
    unitNumber: params.note.topic.unitNumber,
    teacherMethod: params.note.topic.teacherMethod,
    sourceTitles: context.documents.map((document) => document.title),
    chunks,
  });

  const attempt = async (correction: string | null) => {
    const result = await runAiText({
      systemInstruction: prompt.systemInstruction,
      message: correction ? `${prompt.message}\n\n${correction}` : prompt.message,
      maxTokens: 1_400,
      budgetMs: 35_000,
      priority: 'alumno',
    });
    const parsed = outlineSchema.safeParse(extractJsonObject(result.text));
    if (!parsed.success) throw new StudyFormatError(schemaIssue(parsed.error));
    return { outline: parsed.data, model: result.model, provider: result.provider };
  };

  try {
    let first: Awaited<ReturnType<typeof attempt>>;
    try {
      first = await attempt(null);
    } catch (error) {
      if (!(error instanceof StudyFormatError)) throw error;
      first = await attempt(
        `La respuesta anterior no era válida (${error.message}). Devuelve SOLO el JSON del esquema.`
      );
    }

    return {
      sections: first.outline.sections,
      model: first.model,
      provider: first.provider,
      fallback: false,
      warning: null,
      context,
    };
  } catch (error) {
    if (error instanceof StudyFormatError) {
      return outlineFallback(
        context,
        `El catedrático no ha devuelto un esquema válido (${error.message}). Se ha preparado uno a partir de tus fuentes para que puedas editarlo.`
      );
    }
    throw error;
  }
}

/**
 * Esquema de respaldo sin llamar al modelo (sin clave, sin cupo o tras un
 * fallo de formato). Usa las etiquetas de los trozos y deja el lienzo
 * utilizable; la interfaz avisa de que es una propuesta para editar.
 */
export async function fallbackOutlineForNote(params: {
  userId: string;
  note: {
    title: string;
    topicId: string;
    topic: { id: string; title: string; unitNumber: number | null; teacherMethod: string | null };
    subject: { id: string; name: string };
  };
}): Promise<OutlineResult> {
  const context = await selectSourceContext({
    userId: params.userId,
    topicId: params.note.topicId,
    subjectId: params.note.subject.id,
    query: `${params.note.topic.title} ${params.note.title}`,
    budgetChars: 30_000,
    maxChunks: 24,
  });

  return outlineFallback(
    context,
    context.chunks.length > 0
      ? 'Esquema preparado a partir de las etiquetas de tus fuentes. Edítalo antes de desarrollarlo.'
      : 'No hay fuentes con texto para esta unidad. Sube material y vuelve a generar el esquema.'
  );
}

export interface SectionResult {
  generation: SectionGenerationResult;
  model: string | null;
  warning: string | null;
}

function noSourceBlocks(sectionTitle: string): GeneratedBlockInput[] {
  return [
    {
      type: 'TEXT',
      content: [
        `**No consta en tus fuentes.** No hay fragmentos indexados que cubran «${sectionTitle}».`,
        '',
        'Sube el material de esta unidad (PDF, apuntes o una URL) y vuelve a desarrollar el apartado.',
      ].join('\n'),
      chunkId: null,
      quote: null,
    },
  ];
}

/**
 * Desarrolla una sección. Devuelve también los avisos de citas para que la
 * interfaz pueda marcarlas sin volver a consultar la base.
 */
export async function generateSectionForNote(params: {
  userId: string;
  noteId: string;
  note: {
    title: string;
    topic: { title: string; teacherMethod: string | null };
    subject: { id: string; name: string };
    topicId: string;
  };
  section: {
    id: string;
    title: string;
    purpose: string;
    status: NoteSectionStatus;
  };
  siblingTitles: readonly string[];
}): Promise<SectionResult> {
  const context = await selectSourceContext({
    userId: params.userId,
    topicId: params.note.topicId,
    subjectId: params.note.subject.id,
    query: `${params.section.title} ${params.section.purpose}`,
    budgetChars: 26_000,
    maxChunks: 16,
  });

  const allowed = context.allowed;
  const chunks = packPromptChunks(context.chunks);

  if (chunks.length === 0) {
    const validated = validateGeneratedBlocks({
      userId: params.userId,
      blocks: noSourceBlocks(params.section.title),
      allowed,
    });
    const generation = await persistSectionGeneration({
      userId: params.userId,
      noteId: params.noteId,
      sectionId: params.section.id,
      blocks: validated,
    });
    return {
      generation,
      model: null,
      warning: 'No hay fuentes con texto para este apartado: se ha marcado como «no consta».',
    };
  }

  const prompt = buildSectionPrompt({
    subjectName: params.note.subject.name,
    topicTitle: params.note.topic.title,
    sectionTitle: params.section.title,
    sectionPurpose: params.section.purpose,
    siblingTitles: params.siblingTitles,
    teacherMethod: params.note.topic.teacherMethod,
    chunks,
  });

  const parse = (raw: string): GeneratedBlockInput[] => {
    const parsed = sectionSchema.safeParse(extractJsonObject(raw));
    if (!parsed.success) throw new StudyFormatError(schemaIssue(parsed.error));
    return parsed.data.blocks.map((block) => ({
      type: block.type,
      content: block.content,
      chunkId: block.chunkId ?? null,
      quote: block.quote ?? null,
    }));
  };

  let result = await runAiText({
    systemInstruction: prompt.systemInstruction,
    message: prompt.message,
    maxTokens: 2_600,
    budgetMs: 55_000,
    priority: 'alumno',
  });

  let blocks = parse(result.text);
  let validated = validateGeneratedBlocks({ userId: params.userId, blocks, allowed });
  let warning: string | null = null;

  const failing = validated.find(
    (block) => block.quoteStatus === 'ERROR' || block.quoteStatus === 'UNVERIFIED'
  );

  if (failing) {
    // Un único reintento, con el motivo concreto delante. No se manda otra vez
    // el documento entero: el contexto ya está en la conversación del prompt.
    const instruction = citationRetryInstruction({
      status: failing.quoteStatus as 'UNVERIFIED' | 'ERROR',
      reason: failing.citationReason,
    });

    try {
      result = await runAiText({
        systemInstruction: prompt.systemInstruction,
        message: instruction
          ? `${prompt.message}\n\n${instruction}`
          : `${prompt.message}\n\nCorrige las citas y devuelve solo el JSON.`,
        maxTokens: 2_600,
        budgetMs: 55_000,
        priority: 'alumno',
      });
      blocks = parse(result.text);
      const retried = validateGeneratedBlocks({ userId: params.userId, blocks, allowed });
      const better =
        retried.filter((block) => block.quoteStatus === 'VERIFIED').length >=
        validated.filter((block) => block.quoteStatus === 'VERIFIED').length;
      if (better) validated = retried;
      if (
        validated.some(
          (block) => block.quoteStatus === 'UNVERIFIED' || block.quoteStatus === 'ERROR'
        )
      ) {
        warning =
          'Alguna cita no coincide literalmente con la fuente: el bloque se ha guardado marcado para que lo revises.';
      }
    } catch {
      warning =
        'El reintento de citas no ha llegado a tiempo: los bloques se guardan con el estado que se pudo comprobar.';
    }
  }

  const generation = await persistSectionGeneration({
    userId: params.userId,
    noteId: params.noteId,
    sectionId: params.section.id,
    blocks: validated,
  });

  return { generation, model: result.model, warning };
}

/** Genera una variante hija de un bloque, validando su cita. */
export async function generateVariantForBlock(params: {
  userId: string;
  noteId: string;
  subjectName: string;
  topicTitle: string;
  parentBlock: { id: string; content: string };
  variant: VariantKind;
  chunks: PromptChunk[];
  allowed: ReadonlyMap<string, CitationChunk>;
}): Promise<{ block: GeneratedBlockInput & { quoteStatus: string; citationReason: string | null } }> {
  const kind = VARIANT_KINDS[params.variant];
  const prompt = buildVariantPrompt({
    variant: params.variant,
    instruction: kind.instruction,
    subjectName: params.subjectName,
    blockContent: params.parentBlock.content,
    chunks: params.chunks,
  });

  const result = await runAiText({
    systemInstruction: prompt.systemInstruction,
    message: prompt.message,
    maxTokens: 1_400,
    budgetMs: 35_000,
    priority: 'alumno',
  });

  const parsed = variantSchema.safeParse(extractJsonObject(result.text));
  if (!parsed.success) throw new StudyFormatError(schemaIssue(parsed.error));

  const block: GeneratedBlockInput = {
    type: parsed.data.type,
    content: parsed.data.content,
    chunkId: parsed.data.chunkId ?? null,
    quote: parsed.data.quote ?? null,
  };

  const check = block.chunkId || block.quote
    ? checkCitation({
        userId: params.userId,
        chunkId: block.chunkId,
        quote: block.quote,
        allowed: params.allowed,
      })
    : { status: 'NONE' as const, reason: null };

  return {
    block: {
      ...block,
      quoteStatus: check.status,
      citationReason: check.reason,
    },
  };
}
