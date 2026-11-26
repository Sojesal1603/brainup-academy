/**
 * Contrato de respuesta del modo estudio.
 *
 * El prompt pide etiquetas `[[cita:chunkId|frase literal]]`, pero **el prompt no
 * es la garantía**: este módulo vuelve a comprobar cada cita contra el texto de
 * un fragmento que de verdad se envió en el turno y que pertenece a la cuenta.
 *
 * También acepta el sobre JSON `{ sections: [{ text, citations }] }` del plano:
 * si el modelo lo devuelve, se convierte al mismo contrato verificable. Así el
 * validador es uno solo, venga la respuesta en Markdown o en JSON.
 *
 * Lo que se publica:
 *   · cita verificada → `[n]` y una fuente localizable en el pie;
 *   · cita inventada, de otra cuenta o con texto que no aparece → se sustituye
 *     por una marca visible y NO cuenta como cobertura;
 *   · párrafo sin cita → cuenta como «sin respaldo», no como verificado.
 */

import { z } from 'zod';
import { checkCitation, type CitationChunk } from './citation';
import { extractJsonObject } from './prompts';
import type { RetrievalSourceMeta, TutorScope } from './retrieval';

export const studyCitationSchema = z.object({
  chunkId: z.string().trim().min(1).max(200),
  quote: z.string().trim().min(1).max(2_000),
});

export const studyAnswerSchema = z.object({
  sections: z
    .array(
      z.object({
        text: z.string().trim().min(1).max(8_000),
        citations: z.array(studyCitationSchema).max(8).default([]),
      })
    )
    .min(1)
    .max(40),
  outOfScope: z.boolean().optional(),
});

export type StudyAnswerPayload = z.infer<typeof studyAnswerSchema>;

/** Instrucción de ámbito que se añade al prompt según el modo. */
export function buildTutorScopeLayer(params: {
  scope: TutorScope;
  hasSources: boolean;
  corpusBlocks: number;
}): string {
  if (params.scope === 'curiosidad') {
    return [
      '',
      'ÁMBITO: CURIOSIDAD (exploración abierta, fuera del temario cerrado).',
      '- Puedes ampliar con conocimiento general, pero dilo con claridad al empezar: «Fuera de tu temario: …».',
      '- Si el material del alumno sostiene una parte, cítala con la página o el apartado; no mezcles una ampliación externa con sus apuntes como si fuera lo mismo.',
      '- No uses este modo para cambiar notas, expediente ni mediciones: eso solo se toca con datos del alumno.',
    ].join('\n');
  }

  if (params.scope === 'examen') {
    return [
      '',
      'ÁMBITO: EXAMEN (sin pistas ni resolución).',
      '- Plantea o corrige como una prueba: no des la solución, no completes pasos por el alumno y no reveles la respuesta.',
      '- Si el alumno pide ayuda a mitad, recuérdale que está en examen y ofrécele pasar a estudio o curiosidad.',
    ].join('\n');
  }

  return [
    '',
    'ÁMBITO: ESTUDIO ESTRICTO (cerrado a los materiales del alumno).',
    params.hasSources
      ? '- Solo puedes afirmar lo que esté sostenido por los FRAGMENTOS CITABLES de este turno.'
      : '- No hay fragmentos citables de esta materia en este turno: no afirmes contenido como si estuviera en su temario.',
    '- CADA párrafo que afirme algo debe terminar con una cita literal con este formato exacto:',
    '  [[cita:ID_DEL_FRAGMENTO|"frase copiada palabra por palabra del fragmento"]]',
    '- El ID debe ser uno de los que aparecen entre corchetes en los FRAGMENTOS CITABLES. No inventes IDs.',
    '- La frase citada debe existir LITERALMENTE en ese fragmento: mismas palabras y cifras.',
    '- Si no puedes citar una afirmación, no la hagas: escribe «No consta en tu temario» y di qué material falta.',
    '- Si toda la pregunta queda fuera de sus materiales, responde solo con [[fuera_de_temario]] y una frase honesta; el sistema ofrecerá el modo curiosidad.',
    '- No completes con conocimiento general ni con lo que «suele» aparecer en el libro.',
  ].join('\n');
}

/** Respuesta determinista para una pregunta fuera del material, sin llamar al modelo. */
export function buildStrictOutOfScopeReply(
  reason: 'sin_fuentes' | 'sin_coincidencias' | null
): string {
  if (reason === 'sin_fuentes') {
    return [
      '**No tengo material tuyo de esta materia para responder en modo estudio.**',
      '',
      'En modo estudio solo uso tu temario, tus apuntes y los documentos que hayas subido. Ahora mismo no hay ninguno indexado de esta asignatura, así que no voy a completar la respuesta con conocimiento general.',
      '',
      'Puedes subir tus apuntes o el PDF del tema y volver a preguntar, o cambiar a **modo curiosidad** si quieres una explicación abierta (quedará etiquetada como fuera de tu temario).',
    ].join('\n');
  }

  return [
    '**Esto no consta en tu temario.**',
    '',
    'He buscado en tus apuntes y documentos de esta materia y no hay un fragmento que sostenga la respuesta. No voy a inventarlo ni completarlo con conocimiento general.',
    '',
    'Puedes ampliar tus apuntes con ese apartado y volver a preguntar, o cambiar a **modo curiosidad** para una explicación abierta (quedará etiquetada como fuera de tu temario).',
  ].join('\n');
}

/** Extrae el sobre JSON del plano y lo convierte al contrato de etiquetas. */
export function normalizeStudyAnswer(raw: string): { text: string; explicitOutOfScope: boolean } {
  const object = extractJsonObject(raw);
  const parsed = studyAnswerSchema.safeParse(object);
  if (!parsed.success) {
    return {
      text: String(raw ?? '').trim(),
      explicitOutOfScope: /\[\[\s*fuera_de_temario\s*\]\]/i.test(String(raw ?? '')),
    };
  }

  const text = parsed.data.sections
    .map((section) => {
      const citations = section.citations
        .map((citation) => `[[cita:${citation.chunkId}|${citation.quote}]]`)
        .join(' ');
      return citations.length > 0 ? `${section.text}\n\n${citations}` : section.text;
    })
    .join('\n\n');

  return { text, explicitOutOfScope: parsed.data.outOfScope === true };
}

export interface StudySourceRef {
  chunkId: string;
  ref: number;
  title: string;
  label: string;
  pageFrom: number | null;
  pageTo: number | null;
  quote: string;
}

export interface StudyAnswerMeta {
  scope: 'estudio';
  outOfScope: boolean;
  status: 'verificado' | 'parcial' | 'sin_respaldo' | 'vacio';
  coverage: {
    withCitation: number;
    total: number;
    ratio: number;
    citedBlocks: number;
    retrievedBlocks: number;
    corpusBlocks: number;
  };
  sources: StudySourceRef[];
  invalidCitations: number;
  verifiedCitations: number;
}

export interface StudyAnswerValidation {
  markdown: string;
  meta: StudyAnswerMeta;
}

/**
 * Lo que se guarda en `AiMessage.studyMetaJson`. Se valida al leerlo: una fila
 * antigua, corrupta o manipulada no puede romper la conversación ni pintar una
 * cobertura falsa.
 */
const studyMetaSchema = z.object({
  scope: z.literal('estudio'),
  outOfScope: z.boolean(),
  status: z.enum(['verificado', 'parcial', 'sin_respaldo', 'vacio']),
  coverage: z.object({
    withCitation: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    ratio: z.number().min(0).max(1),
    citedBlocks: z.number().int().nonnegative(),
    retrievedBlocks: z.number().int().nonnegative(),
    corpusBlocks: z.number().int().nonnegative(),
  }),
  sources: z
    .array(
      z.object({
        chunkId: z.string().min(1).max(200),
        ref: z.number().int().positive(),
        title: z.string().max(300),
        label: z.string().max(300),
        // `.optional()` evita que una fila antigua sin estas claves rompa la
        // lectura; el transform las devuelve como null, que es lo que pinta la UI.
        pageFrom: z.number().int().nullable().optional().transform((value) => value ?? null),
        pageTo: z.number().int().nullable().optional().transform((value) => value ?? null),
        quote: z.string().max(2_000),
      })
    )
    .max(50),
  invalidCitations: z.number().int().nonnegative(),
  verifiedCitations: z.number().int().nonnegative(),
});

/** Reconstruye la franja de cobertura guardada; null si no hay o no es válida. */
export function parseStudyMeta(raw: string | null | undefined): StudyAnswerMeta | null {
  if (!raw) return null;
  try {
    const parsed = studyMetaSchema.safeParse(JSON.parse(raw));
    // Zod 4 infiere `pageFrom?` para un campo `.nullable()`; el contrato exige la
    // propiedad presente (aunque sea null). La validación ya ha comprobado que
    // existe, así que el cast no relaja nada en runtime.
    return parsed.success ? (parsed.data as StudyAnswerMeta) : null;
  } catch {
    return null;
  }
}

function pageLabel(pageFrom: number | null, pageTo: number | null): string {
  if (pageFrom && pageTo && pageFrom !== pageTo) return `págs. ${pageFrom}-${pageTo}`;
  if (pageFrom) return `pág. ${pageFrom}`;
  return 'sin página';
}

/**
 * Valida todas las etiquetas del texto y devuelve el Markdown que se publica.
 * `allowed` es exactamente lo que se mandó al modelo: ni toda la base ni los
 * documentos de otra materia.
 */
export function validateStudyAnswer(params: {
  raw: string;
  userId: string;
  allowed: ReadonlyMap<string, CitationChunk>;
  meta: ReadonlyMap<string, RetrievalSourceMeta>;
  retrievedBlocks: number;
  corpusBlocks: number;
}): StudyAnswerValidation {
  const normalized = normalizeStudyAnswer(params.raw);
  const explicitOutOfScope =
    normalized.explicitOutOfScope || /\[\[\s*fuera_de_temario\s*\]\]/i.test(normalized.text);

  const sourceByChunk = new Map<string, StudySourceRef>();
  let verifiedCitations = 0;
  let invalidCitations = 0;
  let nextRef = 1;

  const rawBlocks = normalized.text
    .replace(/\[\[\s*fuera_de_temario\s*\]\]/gi, '')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);

  // Un bloque que solo lleva etiquetas de cita pertenece al párrafo anterior.
  // El sobre JSON las manda en una línea aparte; si se separan, el párrafo
  // quedaría «sin cita» y la cita «sin texto», y la cobertura sería falsa.
  const blocks: string[] = [];
  for (const block of rawBlocks) {
    const withoutTags = block
      .replace(/\[\[\s*cita\s*:[^\]]*\]\]/gi, '')
      .trim();
    if (withoutTags.length === 0 && blocks.length > 0) {
      blocks[blocks.length - 1] = `${blocks[blocks.length - 1]}\n\n${block}`;
    } else {
      blocks.push(block);
    }
  }

  const sections: Array<{ verified: number; invalid: number; body: string }> = [];

  const renderedBlocks = blocks.map((block) => {
    let blockVerified = 0;
    let blockInvalid = 0;

    const rendered = block.replace(
      /\[\[\s*cita\s*:\s*([^|\]]+?)\s*\|\s*([\s\S]*?)\s*\]\]/gi,
      (_match, rawId: string, rawQuote: string) => {
        const chunkId = rawId.trim();
        const quote = rawQuote.trim().replace(/^["'«“]|["'»”]$/g, '').trim();
        const check = checkCitation({
          userId: params.userId,
          chunkId,
          quote,
          allowed: params.allowed,
        });

        if (check.status !== 'VERIFIED') {
          blockInvalid += 1;
          invalidCitations += 1;
          return ' *(fuente no verificada)*';
        }

        blockVerified += 1;
        verifiedCitations += 1;
        let source = sourceByChunk.get(chunkId);
        if (!source) {
          const descriptor = params.meta.get(chunkId);
          source = {
            chunkId,
            ref: nextRef,
            title: descriptor?.title ?? 'Material del alumno',
            label: descriptor?.label ?? '',
            pageFrom: descriptor?.pageFrom ?? null,
            pageTo: descriptor?.pageTo ?? null,
            quote,
          };
          nextRef += 1;
          sourceByChunk.set(chunkId, source);
        }
        return `[${source.ref}]`;
      }
    );

    const visible = rendered
      .replace(/[*_#>`[\]]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (visible.length >= 60 || (blockVerified + blockInvalid > 0 && visible.length >= 20)) {
      sections.push({ verified: blockVerified, invalid: blockInvalid, body: rendered });
    }

    return rendered;
  });

  const total = sections.length;
  const withCitation = sections.filter((section) => section.verified > 0).length;
  const ratio = total === 0 ? 0 : withCitation / total;
  const citedBlocks = sourceByChunk.size;
  const status: StudyAnswerMeta['status'] =
    total === 0 ? 'vacio' : withCitation === total && invalidCitations === 0 ? 'verificado' : withCitation > 0 ? 'parcial' : 'sin_respaldo';

  const notes: string[] = [];
  if (invalidCitations > 0) {
    notes.push(
      `**Aviso de fuentes:** ${invalidCitations} cita(s) no coincidían con tus materiales y se han marcado. No cuentan como respaldo.`
    );
  }
  if (total > 0 && withCitation === 0) {
    notes.push(
      '**Sin respaldo localizable:** esta respuesta no cita ningún fragmento comprobado de tus materiales.'
    );
  }
  if (sourceByChunk.size > 0) {
    notes.push(
      [
        '**Fuentes verificadas:**',
        ...[...sourceByChunk.values()].map((source) => {
          const label = source.label ? ` · ${source.label}` : '';
          return `[${source.ref}] «${source.title}»${label} · ${pageLabel(source.pageFrom, source.pageTo)}`;
        }),
      ].join('\n')
    );
  }

  const markdown = [renderedBlocks.join('\n\n').trim(), ...notes].filter(Boolean).join('\n\n---\n\n');

  return {
    markdown,
    meta: {
      scope: 'estudio',
      outOfScope: explicitOutOfScope,
      status,
      coverage: {
        withCitation,
        total,
        ratio,
        citedBlocks,
        retrievedBlocks: params.retrievedBlocks,
        corpusBlocks: params.corpusBlocks,
      },
      sources: [...sourceByChunk.values()],
      invalidCitations,
      verifiedCitations,
    },
  };
}
