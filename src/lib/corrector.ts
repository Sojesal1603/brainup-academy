/**
 * Corrector con rúbrica de BrainUp.
 *
 * Tres decisiones que no son de estilo:
 *
 *  1. **Zod, no `JSON.parse` a ciegas.** Una corrección que no encaja en el
 *     esquema se descarta entera; no se rellena con ceros ni con «lo que se haya
 *     podido entender». Una nota inventada es peor que no tener nota.
 *  2. **Dos pasadas y mediana.** Un LLM sube o baja medio punto entre pasadas.
 *     Se corrige dos veces y, por bloque, se toma la mediana: con dos valores
 *     es la media, con tres el central. Así una pasada rara (una respuesta en
 *     blanco que el modelo «interpreta») no decide la nota sola.
 *  3. **La transcripción de una foto manuscrita dice su confianza.** Si la letra
 *     no se lee, se dice; no se corrige un texto inventado.
 */

import { z } from 'zod';
import { runAiText } from './tutor';
import type { AiAttachmentPart } from './aiEngine';
import { TRANSCRIPTION_CONFIDENCE_LABELS, type ExamBlock } from './examenTypes';
import {
  combinePasses,
  looseJson,
  rubricPassSchema,
  type RubricGrading,
  type RubricPass,
} from './correctorRubric';

export { combinePasses, median, rubricPassSchema } from './correctorRubric';
export type { RubricGrading, RubricPass } from './correctorRubric';

function buildPrompt(params: { subjectName: string; blocks: ExamBlock[]; answers: string[] }): string {
  const examText = params.blocks
    .map(
      (block, index) =>
        `BLOQUE ${index + 1} (máx ${block.points} pts) — tema «${block.topicTitle}»:\n${
          block.prompt
        }\nRESPUESTA DEL ALUMNO: ${
          params.answers[index]?.trim() ? params.answers[index].trim() : '(en blanco)'
        }`
    )
    .join('\n\n');

  return `Corrige este simulacro:\n\n${examText}`;
}

function buildSystem(params: { subjectName: string; passes: number }): string {
  return [
    `Eres corrector oficial de la PAU española de «${params.subjectName}».`,
    `Corrige cada bloque sobre un máximo de ${2.5} puntos con esta rúbrica: rigor conceptual (40%), desarrollo justificado paso a paso (30%), resultado correcto (20%), notación y unidades (10%).`,
    'Sé exigente y justo como un corrector real: penaliza resultados sin justificar, unidades ausentes y errores de notación. Una respuesta en blanco puntúa 0.',
    'En "feedback" escribe una crítica breve (2-3 frases) en español que diga exactamente qué falló y cómo se habría asegurado el punto.',
    'En "weakTopicTitles" lista solo los temas con puntuación por debajo del 60% del máximo.',
    `Esta es la pasada ${params.passes}. Corrige por tu cuenta: no supongas que otra pasada ya ha puntuado.`,
    'Devuelve EXCLUSIVAMENTE un JSON con este esquema exacto:',
    '{"blocks":[{"index":0,"score":1.5,"feedback":"..."}],"weakTopicTitles":["tema"],"globalFeedback":"valoración global de 2-3 frases con nota final sobre 10"}',
    'Nada de texto fuera del JSON.',
  ].join('\n');
}

/** Una pasada: devuelve null si la IA falla o el JSON no encaja en el esquema. */
export async function runRubricPass(params: {
  subjectName: string;
  blocks: ExamBlock[];
  answers: string[];
  passNumber?: number;
}): Promise<{ pass: RubricPass; model: string } | null> {
  try {
    const result = await runAiText({
      systemInstruction: buildSystem({
        subjectName: params.subjectName,
        passes: params.passNumber ?? 1,
      }),
      message: buildPrompt(params),
      budgetMs: 75_000,
      attemptMs: 45_000,
    });

    const raw = looseJson(result.text);
    const parsed = rubricPassSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn(
        '[corrector] pasada descartada: el JSON no cumple el esquema —',
        parsed.error.issues[0]?.path.join('.') ?? 'sin ruta'
      );
      return null;
    }
    return { pass: parsed.data, model: result.model };
  } catch (error) {
    console.warn(
      '[corrector] pasada no disponible:',
      error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    );
    return null;
  }
}

/**
 * Corrección completa: dos pasadas (configurable) y mediana por bloque.
 * Devuelve null si NINGUNA pasada es válida; con una sola, esa manda.
 */
export async function gradeWithRubricMedian(params: {
  subjectName: string;
  blocks: ExamBlock[];
  answers: string[];
  passes?: number;
}): Promise<RubricGrading | null> {
  const wanted = Math.max(1, Math.min(3, params.passes ?? 2));
  const valid: RubricPass[] = [];
  let model: string | null = null;

  // En serie a propósito: dos llamadas simultáneas al mismo modelo gratuito se
  // pisan la cuota y suelen acabar las dos en 429.
  for (let i = 1; i <= wanted; i++) {
    const result = await runRubricPass({ ...params, passNumber: i });
    if (result) {
      valid.push(result.pass);
      model = result.model;
    }
  }

  if (valid.length === 0) return null;

  const combined = combinePasses({ passes: valid, blocks: params.blocks });
  return {
    mode: 'ai',
    total: combined.total,
    blocks: combined.blocks,
    weakTopicTitles: combined.weakTopicTitles,
    globalFeedback: combined.globalFeedback,
    model,
    passes: valid.length,
  };
}

/* ------------------------------------------------------------------ */
/* Foto manuscrita                                                     */
/* ------------------------------------------------------------------ */

export const CONFIDENCE_LEVELS = ['alta', 'media', 'baja'] as const;
export type TranscriptionConfidence = (typeof CONFIDENCE_LEVELS)[number];

export const transcriptionSchema = z.object({
  text: z.string().max(40_000).default(''),
  confidence: z.enum(CONFIDENCE_LEVELS),
  // Trozos que no se han podido leer, para que el alumno los repase.
  missingParts: z.array(z.string().trim().max(300)).max(20).default([]),
  note: z.string().trim().max(500).default(''),
});

export type Transcription = z.infer<typeof transcriptionSchema>;

/**
 * Transcribe una foto de una resolución manuscrita.
 *
 * Las imágenes viajan solo a modelos con visión (lo garantiza el motor). Si no
 * hay ninguno sano, la llamada falla y se devuelve null: el alumno puede escribir
 * o subir el texto, pero nadie le va a corregir una transcripción inventada.
 */
export async function transcribeHandwriting(params: {
  subjectName?: string;
  blockPrompt?: string;
  attachments: AiAttachmentPart[];
}): Promise<(Transcription & { model: string }) | null> {
  if (params.attachments.length === 0) return null;

  const systemInstruction = [
    'Eres el transcriptor del Examinador PAU de BrainUp.',
    'Transcribe LITERALMENTE la resolución manuscrita de la imagen: no corrijas, no completes ni interpretes. Respeta tachones y apartados.',
    'La confianza es "alta" solo si se lee todo sin dudar; "media" si dudas en palabras sueltas; "baja" si hay partes ilegibles o la foto no es una resolución.',
    'Si no hay texto legible, devuelve "text": "" y confianza "baja".',
    'En "missingParts" describe los trozos ilegibles; en "note", cualquier aviso de encuadre o nitidez.',
    'Devuelve EXCLUSIVAMENTE este JSON:',
    '{"text":"...","confidence":"alta|media|baja","missingParts":["..."],"note":"..."}',
  ].join('\n');

  const context = [
    params.subjectName ? `Materia: ${params.subjectName}.` : '',
    params.blockPrompt ? `Enunciado que se está resolviendo:\n${params.blockPrompt}` : '',
    'Transcribe la imagen adjunta.',
  ]
    .filter(Boolean)
    .join('\n\n');

  try {
    const result = await runAiText({
      systemInstruction,
      message: context,
      attachments: params.attachments,
      budgetMs: 60_000,
      attemptMs: 40_000,
    });

    const parsed = transcriptionSchema.safeParse(looseJson(result.text));
    if (!parsed.success) {
      console.warn('[corrector] transcripción descartada: JSON fuera de esquema');
      return null;
    }
    return { ...parsed.data, model: result.model };
  } catch (error) {
    console.warn(
      '[corrector] transcripción no disponible:',
      error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    );
    return null;
  }
}

/** Etiqueta legible de la confianza, para la interfaz. */
export function confidenceLabel(confidence: TranscriptionConfidence): string {
  return TRANSCRIPTION_CONFIDENCE_LABELS[confidence];
}
