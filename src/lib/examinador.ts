/**
 * BrainUp Examinador PAU — Generación de simulacros y corrección por rúbrica.
 *
 * Filosofía Local-First y tolerante a fallos:
 *  - Si hay clave de Gemini y cupo, la IA redacta un simulacro estilo PAU y
 *    corrige con rúbrica oficial (0-2,5 puntos por bloque).
 *  - Si no hay IA (sin clave, sin cupo o fallo), el simulacro se genera con
 *    plantillas locales sobre los temas más débiles y la corrección pasa a
 *    modo autoevaluación guiada. La app nunca se queda sin funcionar.
 */

import { prisma } from './prisma';
import { hasAiProvider, runAiText } from './tutor';
import type { BlockResult, ExamBlock, ExamGrade, ExamPackage } from './examenTypes';

export type { BlockResult, ExamBlock, ExamGrade, ExamPackage } from './examenTypes';

export const PAU_TIMED_MINUTES = 90;

export const PAU_BLOCKS = 4;

export const BLOCK_POINTS = 2.5;

/** Corrección devuelta por la IA (siempre en modo 'ai'). */
export type AiGrading = ExamGrade & { mode: 'ai' };

/* ------------------------------------------------------------------ */
/* Utilidades de parseo JSON robusto                                   */
/* ------------------------------------------------------------------ */

/**
 * Repara los "JSON rotos" típicos de los LLM: saltos de línea y tabuladores
 * literales dentro de las cadenas (JSON estricto no los permite).
 */
function sanitizeControlChars(input: string): string {
  let out = '';
  let inString = false;
  let escaped = false;

  for (const ch of input) {
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }
    if (inString) {
      if (ch === '\n') {
        out += '\\n';
        continue;
      }
      if (ch === '\r') {
        out += '\\r';
        continue;
      }
      if (ch === '\t') {
        out += '\\t';
        continue;
      }
      if (ch.charCodeAt(0) < 0x20) {
        out += ' ';
        continue;
      }
    }
    out += ch;
  }

  return out;
}

/** Elimina comas sobrantes antes de cierres (otro vicio habitual de los LLM). */
function stripTrailingCommas(input: string): string {
  return input.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * Extrae el primer objeto JSON válido del texto aunque venga con fences,
 * saltos de línea literales dentro de cadenas o comas sobrantes.
 */
export function parseJsonLoose(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```json/gi, '```').replace(/```/g, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;

  const slice = cleaned.slice(start, end + 1);
  const attempts = [
    slice,
    sanitizeControlChars(slice),
    stripTrailingCommas(sanitizeControlChars(slice)),
  ];

  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch {
      // Probamos la siguiente variante reparada.
    }
  }

  return null;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function clamp(value: unknown, min: number, max: number): number | null {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.min(max, Math.max(min, num));
}

/** Empareja el título que devuelve la IA con un tema real de la base de datos. */
function matchTopicId(topicTitle: string, topics: Array<{ id: string; title: string }>): string | null {
  const needle = topicTitle.toLowerCase();
  const direct = topics.find((t) => t.title.toLowerCase() === needle);
  if (direct) return direct.id;

  const partial = topics.find(
    (t) => needle.includes(t.title.toLowerCase()) || t.title.toLowerCase().includes(needle)
  );
  return partial?.id ?? null;
}

/* ------------------------------------------------------------------ */
/* Generación del simulacro                                            */
/* ------------------------------------------------------------------ */

/** Plantillas locales: se usan cuando no hay IA disponible. */
const LOCAL_TEMPLATES = [
  (topic: string) =>
    `Teoría aplicada sobre «${topic}». Define los conceptos clave, enuncia las propiedades o teoremas fundamentales y demuéstralos con un ejemplo resuelto paso a paso. Cuida la notación y las unidades.`,
  (topic: string) =>
    `Problema de nivel PAU sobre «${topic}». Resuélvelo íntegramente: plantea los datos, describe la estrategia, desarrolla los cálculos y termina con una conclusión numérica con unidades.`,
  (topic: string) =>
    `Ejercicio de aplicación de «${topic}» con dos apartados: a) razonamiento teórico breve y justificado; b) cálculo práctico asociado. Si el resultado es numérico, valida órdenes de magnitud.`,
  (topic: string) =>
    `Análisis completo de un caso práctico de «${topic}». Interpreta el enunciado, resuelve y después explica en 3 líneas qué error típico se comete en este tipo de pregunta de examen.`,
];

function localBlocks(topics: Array<{ id: string; title: string }>): ExamBlock[] {
  return Array.from({ length: PAU_BLOCKS }).map((_, index) => {
    // Rota sobre los temas más débiles primero; si hay menos temas que bloques, repite.
    const topic = topics[index % topics.length];
    return {
      topicId: topic.id,
      topicTitle: topic.title,
      prompt: LOCAL_TEMPLATES[index % LOCAL_TEMPLATES.length](topic.title),
      points: BLOCK_POINTS,
    };
  });
}

interface ExamTopic {
  id: string;
  title: string;
  masteryLevel: number;
  difficulty: number;
  unitNumber: number | null;
  measured: boolean;
}

/**
 * Temas candidatos del simulacro, en este orden y sin inventar nada:
 *   1. Unidades con nivel MEDIDO flojo (lo que de verdad se te da mal).
 *   2. La unidad que estás dando en clase y las ya vistas (temario real).
 *   3. El resto del temario, por orden de unidad.
 * Antes bastaba con `orderBy masteryLevel asc`, así que un 0% de fábrica ponía
 * cualquier tema como «lo más flojo» sin que nadie lo hubiera medido.
 */
async function pickTopics(subjectId: string): Promise<ExamTopic[]> {
  const all = await prisma.topic.findMany({ where: { subjectId } });

  const toExamTopic = (topic: (typeof all)[number]): ExamTopic => ({
    id: topic.id,
    title: topic.title,
    masteryLevel: topic.masteryLevel,
    difficulty: topic.difficulty,
    unitNumber: topic.unitNumber,
    measured: topic.masterySource !== 'sin_medir',
  });

  const measured = all
    .filter((topic) => topic.masterySource !== 'sin_medir')
    .sort((a, b) => a.masteryLevel - b.masteryLevel || b.difficulty - a.difficulty)
    .map(toExamTopic);

  const seen = all
    .filter(
      (topic) =>
        topic.masterySource === 'sin_medir' && (topic.status === 'en_curso' || topic.status === 'visto' || topic.status === 'repasado')
    )
    .sort((a, b) => (a.unitNumber ?? 999) - (b.unitNumber ?? 999))
    .map(toExamTopic);

  const rest = all
    .filter((topic) => topic.masterySource === 'sin_medir' && topic.status === 'pendiente')
    .sort((a, b) => (a.unitNumber ?? 999) - (b.unitNumber ?? 999))
    .map(toExamTopic);

  const ordered = [...measured, ...seen, ...rest];
  const unique = new Map<string, ExamTopic>();
  for (const topic of ordered) {
    if (!unique.has(topic.id)) unique.set(topic.id, topic);
    if (unique.size >= 8) break;
  }
  return [...unique.values()];
}

/**
 * Genera el paquete de simulacro para una asignatura.
 * Intenta IA primero; si no puede, cae a las plantillas locales.
 */
export async function buildExamPackage(subjectId: string): Promise<ExamPackage> {
  const subject = await prisma.subject.findUnique({ where: { id: subjectId } });
  if (!subject) throw new Error('Asignatura no encontrada en la base de datos.');

  const topics = await pickTopics(subjectId);
  if (topics.length === 0) {
    throw new Error('Esta asignatura aún no tiene temas en el banco. Añádelos en el Cuaderno para generar simulacros.');
  }

  if (!hasAiProvider()) {
    return { source: 'local', blocks: localBlocks(topics) };
  }

  const systemInstruction = [
    `Eres examinador oficial de la PAU española en la asignatura «${subject.name}».`,
    `Redacta un simulacro de examen con exactamente ${PAU_BLOCKS} bloques de ${BLOCK_POINTS} puntos cada uno (total 10).`,
    'Formato clásico PAU: alterna teoría aplicada breve y problemas completos; incluye al menos un apartado numérico o demostración.',
    `Temas disponibles para el examen: ${topics
      .map((t) =>
        t.measured
          ? `«${t.title}» (nivel medido ${t.masteryLevel}%)`
          : `«${t.title}» (nivel sin medir${t.unitNumber ? `, U${t.unitNumber}` : ''})`
      )
      .join(', ')}.`,
    'Reparte los bloques entre los temas con nivel medido más bajo y las unidades que está dando en clase. De los temas sin medir no sabes su nivel: no los presentes como debilidad, simplemente evalúalos.',
    'En el campo "topic" de cada bloque usa EXACTAMENTE uno de los títulos anteriores, copiado carácter a carácter (sin abreviar ni inventar títulos nuevos).',
    'Escribe las expresiones matemáticas en LaTeX simple entre $...$ (por ejemplo: $\\frac{1}{2}mv^2$).',
    'Español de España, tono de examen oficial, sin soluciones ni pistas.',
    'Devuelve EXCLUSIVAMENTE un JSON con este esquema exacto:',
    '{"blocks":[{"topic":"título del tema","prompt":"enunciado completo del bloque","points":2.5}]}',
    'Nada de texto fuera del JSON.',
  ].join('\n');

  try {
    // Un simulacro completo (varios bloques en JSON) es una respuesta larga: se le
    // da más margen que al chat, que es lo que se está aligerando.
    const result = await runAiText({
      systemInstruction,
      message: 'Genera ahora el simulacro completo en JSON.',
      budgetMs: 75_000,
      attemptMs: 45_000,
    });

    const parsed = parseJsonLoose(result.text);
    const rawBlocks = parsed && Array.isArray(parsed.blocks) ? (parsed.blocks as unknown[]) : null;

    const blocks: ExamBlock[] = [];
    if (rawBlocks) {
      for (const item of rawBlocks.slice(0, PAU_BLOCKS)) {
        const entry = item as Record<string, unknown>;
        const prompt = asString(entry.prompt);
        if (!prompt) continue;
        const topicTitle = asString(entry.topic) || topics[blocks.length % topics.length].title;
        blocks.push({
          topicId: matchTopicId(topicTitle, topics),
          topicTitle,
          prompt,
          points: clamp(entry.points, 0.5, 4) ?? BLOCK_POINTS,
        });
      }
    }

    if (blocks.length > 0) {
      return { source: 'ai', model: result.model, blocks };
    }

    console.warn(
      '[examinador] La IA no devolvió bloques válidos; uso plantillas locales. Respuesta:',
      result.text.slice(0, 400)
    );
  } catch (error) {
    // Cupo agotado, clave inválida o error de red: seguimos con plantillas locales.
    console.warn(
      '[examinador] Generación con IA no disponible; uso plantillas locales:',
      error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    );
  }

  return { source: 'local', blocks: localBlocks(topics) };
}

/* ------------------------------------------------------------------ */
/* Corrección por rúbrica                                              */
/* ------------------------------------------------------------------ */

/**
 * Corrige las respuestas con una rúbrica PAU: rigor conceptual, desarrollo
 * justificado, resultado y notación/unidades. Devuelve null si la IA no está
 * disponible (el llamante pasa a modo autoevaluación).
 */
export async function gradeWithRubric(params: {
  subjectName: string;
  blocks: ExamBlock[];
  answers: string[];
}): Promise<AiGrading | null> {
  if (!hasAiProvider()) return null;

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

  const systemInstruction = [
    `Eres corrector oficial de la PAU española de «${params.subjectName}».`,
    `Corrige cada bloque sobre un máximo de ${BLOCK_POINTS} puntos con esta rúbrica: rigor conceptual (40%), desarrollo justificado paso a paso (30%), resultado correcto (20%), notación y unidades (10%).`,
    'Sé exigente y justo como un corrector real: penaliza resultados sin justificar, unidades ausentes y errores de notación. Una respuesta en blanco puntúa 0.',
    'En "feedback" escribe una crítica breve (2-3 frases) en español que diga exactamente qué falló y cómo se habría asegurado el punto.',
    'En "weakTopicTitles" lista solo los temas con puntuación por debajo del 60% del máximo.',
    'Devuelve EXCLUSIVAMENTE un JSON con este esquema exacto:',
    '{"blocks":[{"index":0,"score":1.5,"feedback":"..."}],"weakTopicTitles":["tema"],"globalFeedback":"valoración global de 2-3 frases con nota final sobre 10"}',
    'Nada de texto fuera del JSON.',
  ].join('\n');

  try {
    // Corregir es correr todas las rúbricas de golpe: mismo margen largo que al
    // generar el examen.
    const result = await runAiText({
      systemInstruction,
      message: `Corrige este simulacro:\n\n${examText}`,
      budgetMs: 75_000,
      attemptMs: 45_000,
    });

    const parsed = parseJsonLoose(result.text);
    if (!parsed) return null;

    const rawBlocks = Array.isArray(parsed.blocks) ? (parsed.blocks as unknown[]) : [];
    if (rawBlocks.length === 0) return null;

    const blockResults: BlockResult[] = params.blocks.map((block, index) => {
      const found = rawBlocks
        .map((b) => b as Record<string, unknown>)
        .find((b) => Number(b.index) === index);
      const score = clamp(found?.score, 0, block.points) ?? 0;
      return {
        score: Math.round(score * 4) / 4, // cuartos de punto, como la PAU
        max: block.points,
        feedback: asString(found?.feedback) || 'Sin comentario del corrector para este bloque.',
      };
    });

    const total = Math.round(blockResults.reduce((acc, b) => acc + b.score, 0) * 100) / 100;

    const weakTopicTitles = Array.isArray(parsed.weakTopicTitles)
      ? (parsed.weakTopicTitles as unknown[]).map(asString).filter((t) => t.length > 0)
      : blockResults
          .map((b, i) => (b.score < b.max * 0.6 ? params.blocks[i].topicTitle : ''))
          .filter((t) => t.length > 0);

    return {
      mode: 'ai',
      total,
      blocks: blockResults,
      weakTopicTitles,
      globalFeedback:
        asString(parsed.globalFeedback) ||
        `Nota final del simulacro: ${total.toFixed(1)} / 10.`,
      model: result.model,
    };
  } catch (error) {
    console.warn(
      '[examinador] Corrección con IA no disponible; paso a autoevaluación:',
      error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    );
    return null;
  }
}
