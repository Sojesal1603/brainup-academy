/**
 * Reglas puras del corrector: esquema de la pasada, mediana y combinación.
 *
 * Sin IA y sin Prisma a propósito: `scripts/verify-corrector.js` las compila
 * sola y comprueba las cuentas sin gastar una llamada ni una clave.
 */

import { z } from 'zod';
import type { BlockResult, ExamBlock } from './examenTypes';

export const RUBRIC_WEIGHTS = {
  rigor: 0.4,
  desarrollo: 0.3,
  resultado: 0.2,
  notacion: 0.1,
} as const;

/** Una pasada del corrector, tal y como debe llegar del modelo. */
export const rubricPassSchema = z.object({
  blocks: z
    .array(
      z.object({
        index: z.coerce.number().int().min(0).max(50),
        // El modelo a veces devuelve "1,5": se acepta y se convierte. Con
        // `z.coerce.number()` a secas, "1,5" se volvería NaN y la pasada se
        // tiraría por un detalle de formato, no por una nota mala.
        score: z.preprocess(
          (value) => (typeof value === 'string' ? Number(value.replace(',', '.')) : value),
          z.number().min(0).max(10)
        ),
        feedback: z.string().trim().max(2_000).default(''),
      })
    )
    .min(1),
  weakTopicTitles: z.array(z.string().trim().max(160)).max(20).default([]),
  globalFeedback: z.string().trim().max(2_000).default(''),
});

export type RubricPass = z.infer<typeof rubricPassSchema>;

export interface RubricGrading {
  mode: 'ai';
  total: number;
  blocks: BlockResult[];
  weakTopicTitles: string[];
  globalFeedback: string;
  model: string | null;
  /** Cuántas pasadas válidas han entrado en la mediana. */
  passes: number;
}

/** Mediana real: con un número par de valores, la media de los dos centrales. */
export function median(values: number[]): number {
  const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (clean.length === 0) return 0;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 === 1 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
}

function roundQuarter(value: number): number {
  return Math.round(value * 4) / 4; // cuartos de punto, como la PAU
}

function clamp(value: unknown, min: number, max: number): number | null {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.min(max, Math.max(min, num));
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Repara los saltos de línea literales dentro de cadenas del JSON del modelo. */
export function looseJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const slice = text.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    try {
      return JSON.parse(slice.replace(/\r?\n/g, '\\n').replace(/\t/g, '\\t'));
    } catch {
      return null;
    }
  }
}

/**
 * Combina varias pasadas: mediana por bloque, el comentario más largo (el que
 * se ha molestado en explicar algo) y los temas flojos de todas las pasadas.
 */
export function combinePasses(params: {
  passes: RubricPass[];
  blocks: ExamBlock[];
}): { blocks: BlockResult[]; total: number; weakTopicTitles: string[]; globalFeedback: string } {
  const { passes, blocks } = params;

  const blockResults: BlockResult[] = blocks.map((block, index) => {
    const scores: number[] = [];
    const feedbacks: string[] = [];

    for (const pass of passes) {
      const found = pass.blocks.find((b) => b.index === index);
      const score = clamp(found?.score, 0, block.points);
      if (score !== null) scores.push(score);
      const feedback = asText(found?.feedback);
      if (feedback) feedbacks.push(feedback);
    }

    const chosen = feedbacks.sort((a, b) => b.length - a.length)[0] ?? '';
    return {
      score: roundQuarter(median(scores)),
      max: block.points,
      feedback: chosen || 'Sin comentario del corrector para este bloque.',
      scores,
    };
  });

  const total = Math.round(blockResults.reduce((acc, b) => acc + b.score, 0) * 100) / 100;

  const weak = new Set<string>();
  for (const pass of passes) {
    for (const title of pass.weakTopicTitles) {
      if (title) weak.add(title);
    }
  }
  if (weak.size === 0) {
    blockResults.forEach((result, index) => {
      if (result.score < result.max * 0.6) weak.add(blocks[index].topicTitle);
    });
  }

  const globalFeedback =
    passes.map((p) => asText(p.globalFeedback)).sort((a, b) => b.length - a.length)[0] || '';

  return {
    blocks: blockResults,
    total,
    weakTopicTitles: [...weak],
    globalFeedback:
      globalFeedback ||
      `Nota final del simulacro: ${total.toFixed(1)} / 10, mediana de ${passes.length} pasada(s).`,
  };
}

