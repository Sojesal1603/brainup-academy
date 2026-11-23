/**
 * Prompts y esquemas JSON del lienzo Outline-First.
 *
 * Dos decisiones que importan:
 *
 *   1. **El esquema se pide aparte del cuerpo.** Primero títulos y propósitos
 *      (segundos); después se desarrolla lo que el alumno quiera. Así no se
 *      paga una redacción entera para descubrir que la estructura no servía.
 *   2. **La respuesta se valida con zod y se exige JSON puro.** Un modelo que
 *      contesta con prosa se rechaza y se reintenta; no se intenta «arreglar»
 *      con expresiones regulares creativas.
 *
 * La instrucción de citas es deliberadamente literal: `chunkId` de la lista y
 * `quote` copiada del texto. El validador (`citation.ts`) comprueba después que
 * sea verdad; el prompt no es la garantía.
 */

import { z } from 'zod';

export const OUTLINE_MIN_SECTIONS = 4;
export const OUTLINE_MAX_SECTIONS = 12;
export const SECTION_MAX_BLOCKS = 12;
export const PROMPT_CHUNK_CHARS = 1_200;
export const PROMPT_TOTAL_CHARS = 30_000;

export const outlineSchema = z.object({
  sections: z
    .array(
      z.object({
        title: z.string().trim().min(3).max(160),
        purpose: z.string().trim().max(400).default(''),
        pageFrom: z.number().int().positive().nullable().optional(),
        pageTo: z.number().int().positive().nullable().optional(),
      })
    )
    .min(OUTLINE_MIN_SECTIONS)
    .max(OUTLINE_MAX_SECTIONS),
});

export type OutlinePayload = z.infer<typeof outlineSchema>;

export const blockTypeSchema = z.enum([
  'TEXT',
  'FORMULA',
  'DEFINITION',
  'EXAMPLE',
  'EVIDENCE',
  'QUESTION',
]);

export const sectionSchema = z.object({
  blocks: z
    .array(
      z.object({
        type: blockTypeSchema.default('TEXT'),
        content: z.string().trim().min(1).max(4_000),
        chunkId: z.string().trim().min(1).max(64).nullable().optional(),
        quote: z.string().trim().max(1_200).nullable().optional(),
      })
    )
    .min(1)
    .max(SECTION_MAX_BLOCKS),
});

export type SectionPayload = z.infer<typeof sectionSchema>;

export const variantSchema = z.object({
  content: z.string().trim().min(1).max(4_000),
  chunkId: z.string().trim().min(1).max(64).nullable().optional(),
  quote: z.string().trim().max(1_200).nullable().optional(),
  type: blockTypeSchema.default('TEXT'),
});

export type VariantPayload = z.infer<typeof variantSchema>;

/**
 * Extrae el primer objeto JSON de una respuesta. Tolera vallas de Markdown y
 * texto alrededor, pero no «repara» JSON roto: si no parsea, devuelve `null`.
 */
export function extractJsonObject(raw: string): unknown | null {
  const text = String(raw ?? '').trim();
  if (!text) return null;

  const withoutFence = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;

  const candidate = withoutFence.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

/** Primer error legible de un esquema, para el reintento (sin volcar el JSON). */
export function schemaIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'La respuesta no tiene el formato esperado.';
  const path = issue.path.join('.');
  return `${path ? `${path}: ` : ''}${issue.message}`;
}

export interface PromptChunk {
  id: string;
  label: string;
  pageFrom: number | null;
  pageTo: number | null;
  text: string;
}

function pageLabel(chunk: PromptChunk): string {
  if (chunk.pageFrom && chunk.pageTo && chunk.pageFrom !== chunk.pageTo) {
    return `págs. ${chunk.pageFrom}-${chunk.pageTo}`;
  }
  if (chunk.pageFrom) return `pág. ${chunk.pageFrom}`;
  return 'sin página';
}

/** Recorta el conjunto de trozos a un presupuesto, respetando el orden. */
export function packPromptChunks(
  chunks: readonly PromptChunk[],
  budget = PROMPT_TOTAL_CHARS
): PromptChunk[] {
  const packed: PromptChunk[] = [];
  let used = 0;
  for (const chunk of chunks) {
    const text = chunk.text.length > PROMPT_CHUNK_CHARS
      ? `${chunk.text.slice(0, PROMPT_CHUNK_CHARS)}…`
      : chunk.text;
    if (used + text.length > budget) break;
    packed.push({ ...chunk, text });
    used += text.length;
  }
  return packed;
}

/** Bloque de contexto con identificadores que el modelo debe citar tal cual. */
export function renderChunkContext(chunks: readonly PromptChunk[]): string {
  return chunks
    .map(
      (chunk) =>
        `[${chunk.id} | ${chunk.label || 'fragmento'} | ${pageLabel(chunk)}]\n${chunk.text}`
    )
    .join('\n\n');
}

export function buildOutlinePrompt(params: {
  subjectName: string;
  topicTitle: string;
  unitNumber: number | null;
  teacherMethod?: string | null;
  sourceTitles: readonly string[];
  chunks: readonly PromptChunk[];
}): { systemInstruction: string; message: string } {
  const systemInstruction = [
    'Eres el catedrático que prepara el ESQUEMA de un apunte universitario de bachillerato.',
    'No redactas el cuerpo: solo propones los apartados y para qué sirve cada uno.',
    'Respondes SIEMPRE con un objeto JSON válido, sin texto antes ni después, con esta forma:',
    '{ "sections": [ { "title": "...", "purpose": "...", "pageFrom": 12, "pageTo": 15 } ] }',
    `Entre ${OUTLINE_MIN_SECTIONS} y ${OUTLINE_MAX_SECTIONS} apartados, en orden de estudio.`,
    'Cada apartado debe apoyarse en los fragmentos dados. Si algo del temario no está',
    'en las fuentes, NO lo conviertas en apartado: el esquema refleja lo que se puede sostener.',
    '`pageFrom`/`pageTo` son las páginas reales del fragmento que cubre el apartado, o null.',
  ].join('\n');

  const message = [
    `Asignatura: ${params.subjectName}`,
    `Unidad: ${params.unitNumber ? `U${params.unitNumber} · ` : ''}${params.topicTitle}`,
    params.teacherMethod
      ? `Cómo lo explica el profesor: ${params.teacherMethod}`
      : 'Sin método de profesor declarado: sigue el orden de las fuentes.',
    `Fuentes: ${params.sourceTitles.join(', ') || 'ninguna'}`,
    '',
    'FRAGMENTOS DISPONIBLES:',
    renderChunkContext(params.chunks) || '(no hay fragmentos: no inventes apartados)',
    '',
    'Devuelve solo el JSON del esquema.',
  ].join('\n');

  return { systemInstruction, message };
}

export function buildSectionPrompt(params: {
  subjectName: string;
  topicTitle: string;
  sectionTitle: string;
  sectionPurpose: string;
  siblingTitles: readonly string[];
  teacherMethod?: string | null;
  chunks: readonly PromptChunk[];
}): { systemInstruction: string; message: string } {
  const systemInstruction = [
    'Eres el catedrático que desarrolla UN apartado de un apunte.',
    'Escribes Markdown con KaTeX ($…$ en línea, $$…$$ en bloque), en español y sin relleno.',
    'Respondes SIEMPRE con JSON válido, sin texto alrededor:',
    '{ "blocks": [ { "type": "TEXT|FORMULA|DEFINITION|EXAMPLE|EVIDENCE|QUESTION",',
    '  "content": "Markdown", "chunkId": "id-del-fragmento", "quote": "frase exacta" } ] }',
    '',
    'REGLA DE CITAS (obligatoria):',
    '- Si el bloque afirma algo que sale de una fuente, incluye `chunkId` y `quote`.',
    '- `quote` se copia LITERALMENTE del fragmento: mismas palabras y cifras.',
    '- Si no puedes copiar una frase exacta, no incluyas cita y redacta sin afirmar hechos.',
    '- Si la fuente no cubre el apartado, devuelve un único bloque TEXT que empiece por',
    '  «No consta en tus fuentes» y explique qué falta. No completes con conocimiento general.',
    '',
    `Entre 2 y ${SECTION_MAX_BLOCKS} bloques. Una idea por bloque.`,
    'No repitas los títulos de los apartados hermanos.',
  ].join('\n');

  const message = [
    `Asignatura: ${params.subjectName}`,
    `Unidad: ${params.topicTitle}`,
    `Apartado a desarrollar: ${params.sectionTitle}`,
    params.sectionPurpose ? `Para qué sirve: ${params.sectionPurpose}` : '',
    params.teacherMethod ? `Criterio del profesor: ${params.teacherMethod}` : '',
    params.siblingTitles.length > 0
      ? `Otros apartados del mismo apunte (no los repitas): ${params.siblingTitles.join(' · ')}`
      : '',
    '',
    'FRAGMENTOS PARA ESTE APARTADO:',
    renderChunkContext(params.chunks) || '(sin fragmentos)',
    '',
    'Devuelve solo el JSON de los bloques.',
  ]
    .filter((line) => line.length > 0)
    .join('\n');

  return { systemInstruction, message };
}

export function buildVariantPrompt(params: {
  variant: 'simpler' | 'example' | 'deeper';
  instruction: string;
  subjectName: string;
  blockContent: string;
  chunks: readonly PromptChunk[];
}): { systemInstruction: string; message: string } {
  const systemInstruction = [
    'Amplías UN bloque de un apunte sin repetirlo y sin contradecirlo.',
    'Markdown con KaTeX. Respondes solo con JSON:',
    '{ "content": "Markdown", "chunkId": "id o null", "quote": "frase exacta o null", "type": "TEXT" }',
    'Si afirmas algo de la fuente, copia la cita literal. Si no está, no lo afirmes.',
  ].join('\n');

  const message = [
    `Asignatura: ${params.subjectName}`,
    `Tarea: ${params.instruction}`,
    '',
    'BLOQUE ORIGINAL:',
    params.blockContent,
    '',
    'FRAGMENTOS DISPONIBLES:',
    renderChunkContext(params.chunks) || '(sin fragmentos)',
    '',
    `Devuelve solo el JSON de la variante «${params.variant}».`,
  ].join('\n');

  return { systemInstruction, message };
}

/**
 * Esquema de respaldo cuando no hay proveedor de IA: usa las etiquetas de los
 * trozos. Es peor que el del catedrático, pero es honesto, instantáneo y deja
 * el lienzo utilizable en vez de una pantalla vacía.
 */
export function fallbackOutline(
  chunks: ReadonlyArray<{ label: string; pageFrom: number | null; pageTo: number | null }>,
  maxSections = OUTLINE_MAX_SECTIONS
): OutlinePayload {
  const seen = new Set<string>();
  const sections: OutlinePayload['sections'] = [];

  for (const chunk of chunks) {
    const title = String(chunk.label ?? '').trim().slice(0, 160);
    if (title.length < 3) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    sections.push({
      title,
      purpose: 'Apartado detectado en tus fuentes. Revísalo y ajústalo antes de desarrollarlo.',
      pageFrom: chunk.pageFrom,
      pageTo: chunk.pageTo ?? chunk.pageFrom,
    });
    if (sections.length >= maxSections) break;
  }

  if (sections.length === 0) {
    sections.push({
      title: 'Contenido de la unidad',
      purpose: 'Sin fuentes indexadas: el esquema se generará cuando subas material.',
      pageFrom: null,
      pageTo: null,
    });
  }

  return { sections };
}
