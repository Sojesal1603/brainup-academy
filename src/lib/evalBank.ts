/**
 * Banco de evaluación del corrector.
 *
 * Un corrector sin referencia no se puede mejorar: solo se puede *opinar* sobre
 * él. Aquí hay resoluciones con nota puesta a mano por materia y bloque; el
 * corrector las puntúa a ciegas (dos pasadas, mediana) y se compara con la nota
 * de referencia. Lo que se publica es el **error absoluto medio (MAE)**: cuántos
 * puntos se equivoca de media, en la escala real de la PAU (0–2,5 por bloque).
 *
 * El banco es pequeño a propósito: son casos que se pueden discutir uno a uno.
 * Un centenar de casos mal etiquetados mide peor que cuatro buenos.
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gradeWithRubricMedian } from './corrector';
import {
  EVAL_CASES,
  summarizeResults,
  type EvalCase,
  type EvalCaseResult,
  type EvalSummary,
} from './evalMetrics';

export { EVAL_CASES, evalCaseSchema, meanAbsoluteError, summarizeResults } from './evalMetrics';
export type { EvalCase, EvalCaseResult, EvalGroup, EvalSummary } from './evalMetrics';

export interface EvalRun {
  ranAt: string;
  model: string | null;
  passes: number;
  summary: EvalSummary;
  results: EvalCaseResult[];
}

/** Corre el banco entero. Cada caso se corrige dos veces (mediana). */
export async function runEvalBank(cases: EvalCase[] = EVAL_CASES): Promise<EvalRun> {
  const results: EvalCaseResult[] = [];
  let model: string | null = null;
  let passes = 0;

  for (const item of cases) {
    const grading = await gradeWithRubricMedian({
      subjectName: item.subject,
      blocks: [
        {
          topicId: null,
          topicTitle: item.topicTitle,
          prompt: item.prompt,
          points: item.maxPoints,
        },
      ],
      answers: [item.answer],
    });
    if (!grading) {
      throw new Error(
        `El corrector no ha devuelto ninguna pasada válida en «${item.id}»: sin IA no se puede medir.`
      );
    }
    const gotScore = grading.blocks[0]?.score ?? 0;
    model = grading.model ?? model;
    passes = Math.max(passes, grading.passes);
    results.push({
      id: item.id,
      subject: item.subject,
      block: item.block,
      expectedScore: item.expectedScore,
      gotScore,
      absoluteError: Math.round(Math.abs(gotScore - item.expectedScore) * 100) / 100,
    });
  }

  return {
    ranAt: new Date().toISOString(),
    model,
    passes,
    summary: summarizeResults(results),
    results,
  };
}

const RUNS_DIR = path.join(process.cwd(), 'data', 'eval-runs');

export async function saveEvalRun(run: EvalRun): Promise<string> {
  await mkdir(RUNS_DIR, { recursive: true });
  const name = `${run.ranAt.replace(/[:.]/g, '-')}.json`;
  const file = path.join(RUNS_DIR, name);
  await writeFile(file, JSON.stringify(run, null, 2), 'utf8');
  return file;
}

/**
 * Última medición guardada, o null si el banco aún no se ha corrido. Se lee del
 * disco igual que los adjuntos: es un dato de este servidor, no de la cuenta.
 */
export async function latestEvalRun(): Promise<EvalRun | null> {
  try {
    const files = (await readdir(RUNS_DIR)).filter((f) => f.endsWith('.json')).sort();
    const last = files[files.length - 1];
    if (!last) return null;
    const raw = await readFile(path.join(RUNS_DIR, last), 'utf8');
    const parsed = JSON.parse(raw) as EvalRun;
    return parsed.summary && Array.isArray(parsed.results) ? parsed : null;
  } catch {
    return null;
  }
}
