/**
 * Simulador EBAU por comunidad, corrección cruzada y auditoría de errores.
 *
 * Tres piezas, en este orden:
 *
 *   1. **Generar** un simulacro con la estructura de la comunidad del alumno
 *      (duración, bloques, opciones y peso de la notación), priorizando las
 *      unidades con nivel medido más bajo. Si la IA no está disponible, cae a
 *      un examen local con la misma estructura: la app nunca se queda sin
 *      examinar.
 *   2. **Corregir** la resolución del alumno —texto o documentos adjuntos— con
 *      nota numérica, desglose por apartados y lista de fallos de notación.
 *   3. **Auditar**: cada bloque por debajo del 60% abre una ficha en el Banco de
 *      Errores y crea una píldora de repaso prioritaria en el plan de hoy.
 *
 * El motor no escribe en la agenda desde el prompt: la IA propone, el código
 * valida y Prisma guarda. Igual que en el resto del sistema.
 */

import { db } from './db';
import { hasAiProviderAsync, runAiText } from './tutor';
import { parseJsonLoose } from './examinador';
import {
  getEbauCommunity,
  communityStructureLabel,
  type EbauCommunity,
} from './ebauCommunities';
import type {
  BlockResult,
  ExamApartadoResult,
  ExamAudit,
  ExamBlock,
  ExamGrade,
  ExamPackage,
} from './examenTypes';

/** Píldora de repaso que se crea tras un fallo de simulacro. */
export const EBAU_ERROR_PILL_MINUTES = 15;
/** Por debajo de este porcentaje del bloque, el fallo es conceptual. */
export const EBAU_WEAK_BLOCK_RATIO = 0.6;

interface ExamTopic {
  id: string;
  title: string;
  masteryLevel: number;
  difficulty: number;
  unitNumber: number | null;
  measured: boolean;
  teacherMethod: string | null;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function clamp(value: unknown, min: number, max: number): number | null {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.min(max, Math.max(min, num));
}

function round4(value: number): number {
  return Math.round(value * 4) / 4;
}

function matchTopicId(
  topicTitle: string,
  topics: Array<{ id: string; title: string }>
): string | null {
  const needle = topicTitle.toLowerCase();
  const direct = topics.find((topic) => topic.title.toLowerCase() === needle);
  if (direct) return direct.id;
  const partial = topics.find(
    (topic) =>
      needle.includes(topic.title.toLowerCase()) ||
      topic.title.toLowerCase().includes(needle)
  );
  return partial?.id ?? null;
}

/**
 * Temas candidatos, sin inventar debilidades:
 *   1. Nivel medido flojo.
 *   2. Lo que está dando en clase y lo ya visto.
 *   3. El resto del temario, por orden de unidad.
 */
async function pickEbauTopics(userId: string, subjectId: string): Promise<ExamTopic[]> {
  const prisma = db(userId);
  const all = await prisma.topic.findMany({ where: { subjectId } });

  const toExamTopic = (topic: (typeof all)[number]): ExamTopic => ({
    id: topic.id,
    title: topic.title,
    masteryLevel: topic.masteryLevel,
    difficulty: topic.difficulty,
    unitNumber: topic.unitNumber,
    measured: topic.masterySource !== 'sin_medir',
    teacherMethod: topic.teacherMethod,
  });

  const measured = all
    .filter((topic) => topic.masterySource !== 'sin_medir')
    .sort((a, b) => a.masteryLevel - b.masteryLevel || b.difficulty - a.difficulty)
    .map(toExamTopic);

  const inClass = all
    .filter(
      (topic) =>
        topic.masterySource === 'sin_medir' &&
        (topic.status === 'en_curso' || topic.status === 'visto' || topic.status === 'repasado')
    )
    .sort((a, b) => (a.unitNumber ?? 999) - (b.unitNumber ?? 999))
    .map(toExamTopic);

  const rest = all
    .filter((topic) => topic.masterySource === 'sin_medir' && topic.status === 'pendiente')
    .sort((a, b) => (a.unitNumber ?? 999) - (b.unitNumber ?? 999))
    .map(toExamTopic);

  const unique = new Map<string, ExamTopic>();
  for (const topic of [...measured, ...inClass, ...rest]) {
    if (!unique.has(topic.id)) unique.set(topic.id, topic);
    if (unique.size >= 8) break;
  }
  return [...unique.values()];
}

const LOCAL_TEMPLATES: Array<(topic: string, method: string | null) => { prompt: string; apartados: string[] }> = [
  (topic, method) => ({
    prompt: `Bloque de teoría aplicada sobre «${topic}».${
      method ? ` Sigue la notación y el método de clase: ${method}` : ''
    }`,
    apartados: [
      'a) Define los conceptos clave y enuncia las propiedades o teoremas fundamentales.',
      'b) Aplícalos a un caso concreto, justificando cada paso y cuidando las unidades.',
    ],
  }),
  (topic) => ({
    prompt: `Problema de examen sobre «${topic}». Resuélvelo íntegramente, como si fuera la EBAU.`,
    apartados: [
      'a) Plantea los datos y la estrategia de resolución.',
      'b) Desarrolla los cálculos y termina con una conclusión numérica con unidades.',
    ],
  }),
  (topic) => ({
    prompt: `Ejercicio de aplicación de «${topic}» con dos apartados.`,
    apartados: [
      'a) Razonamiento teórico breve y justificado.',
      'b) Cálculo práctico asociado, validando el orden de magnitud del resultado.',
    ],
  }),
  (topic) => ({
    prompt: `Análisis completo de un caso práctico de «${topic}».`,
    apartados: [
      'a) Interpreta el enunciado y resuelve, indicando qué principio aplicas.',
      'b) Explica en tres líneas el error típico que se comete en este tipo de pregunta.',
    ],
  }),
];

function localBlocks(topics: ExamTopic[], community: EbauCommunity): ExamBlock[] {
  return Array.from({ length: community.blocks }).map((_, index) => {
    const topic = topics[index % topics.length];
    const template = LOCAL_TEMPLATES[index % LOCAL_TEMPLATES.length](
      topic.title,
      topic.teacherMethod
    );
    return {
      topicId: topic.id,
      topicTitle: topic.title,
      prompt: template.prompt,
      apartados: template.apartados,
      points: community.pointsPerBlock,
    };
  });
}

export interface BuildEbauInput {
  subjectId: string;
  /** Código de comunidad; si falta, se usa la del perfil. */
  communityCode?: string | null;
  /** Lo que el alumno ha pedido reforzar. */
  focus?: string | null;
}

/**
 * Genera el paquete de simulacro. La estructura la manda la comunidad; el
 * contenido, el temario real y el método del profesor.
 */
export async function buildEbauPackage(
  userId: string,
  input: BuildEbauInput
): Promise<ExamPackage> {
  const prisma = db(userId);
  const subject = await prisma.subject.findUnique({
    where: { id: input.subjectId },
    include: { user: true },
  });
  if (!subject) throw new Error('Asignatura no encontrada en la base de datos.');

  const community = getEbauCommunity(
    input.communityCode ?? subject.user?.community ?? null
  );
  const topics = await pickEbauTopics(userId, input.subjectId);
  if (topics.length === 0) {
    throw new Error(
      'Esta asignatura aún no tiene temas en el banco. Añádelos en el Cuaderno para generar simulacros.'
    );
  }

  if (!(await hasAiProviderAsync())) {
    return {
      source: 'local',
      blocks: localBlocks(topics, community),
      community: community.code,
      structure: communityStructureLabel(community),
    };
  }

  const focus = asString(input.focus).slice(0, 600);

  const systemInstruction = [
    `Eres examinador oficial de la EBAU en ${community.name}, asignatura «${subject.name}».`,
    `Estructura obligatoria de esta comunidad: ${community.summary}`,
    `Duración: ${community.durationMinutes} minutos. Bloques: ${community.blocks} de ${community.pointsPerBlock} puntos (total ${community.blocks * community.pointsPerBlock}).`,
    `Opciones: ${community.options === 0 ? 'examen único, sin opciones.' : community.choiceRule}`,
    `Rúbrica de corrección: rigor conceptual 40%, desarrollo justificado 30%, resultado 20%, notación y unidades ${Math.round(community.notationWeight * 100)}%.`,
    `Temas disponibles: ${topics
      .map(
        (topic) =>
          `«${topic.title}» (${topic.measured ? `nivel medido ${topic.masteryLevel}%` : 'nivel sin medir'}${
            topic.unitNumber ? `, U${topic.unitNumber}` : ''
          })`
      )
      .join(', ')}.`,
    'Reparte los bloques entre los temas medidos más flojos y las unidades que está dando en clase. De los temas sin medir no sabes el nivel: evalúalos, no los presentes como debilidad.',
    'Cada bloque debe tener 2 o 3 apartados concretos (a, b, c) y valer lo que marca la estructura.',
    'Usa EXACTAMENTE los títulos de tema recibidos, copiados carácter a carácter.',
    'Escribe las expresiones matemáticas en LaTeX simple entre $...$.',
    'Español de España, tono de examen oficial, sin soluciones ni pistas.',
    ...(focus ? [`El alumno ha pedido reforzar: «${focus}».`] : []),
    ...topics
      .filter((topic) => topic.teacherMethod)
      .slice(0, 3)
      .map(
        (topic) =>
          `Método exigido por su profesor en «${topic.title}»: ${topic.teacherMethod}.`
      ),
    'Devuelve EXCLUSIVAMENTE un JSON válido con este esquema:',
    '{"blocks":[{"topic":"título exacto","prompt":"enunciado completo","apartados":["a) ...","b) ..."],"points":2.5}]}',
    'Nada de texto fuera del JSON.',
  ].join('\n');

  try {
    const result = await runAiText({
      systemInstruction,
      message: 'Genera ahora el simulacro completo en JSON.',
      budgetMs: 75_000,
      attemptMs: 45_000,
    });

    const parsed = parseJsonLoose(result.text);
    const rawBlocks =
      parsed && Array.isArray(parsed.blocks) ? (parsed.blocks as unknown[]) : null;

    const blocks: ExamBlock[] = [];
    if (rawBlocks) {
      for (const item of rawBlocks.slice(0, community.blocks)) {
        const entry = item as Record<string, unknown>;
        const prompt = asString(entry.prompt);
        if (!prompt) continue;
        const topicTitle = asString(entry.topic) || topics[blocks.length % topics.length].title;
        const apartados = Array.isArray(entry.apartados)
          ? entry.apartados.map(asString).filter((line) => line.length > 0).slice(0, 5)
          : [];
        blocks.push({
          topicId: matchTopicId(topicTitle, topics),
          topicTitle,
          prompt,
          apartados: apartados.length > 0 ? apartados : undefined,
          points:
            clamp(entry.points, 0.5, 4) ?? community.pointsPerBlock,
        });
      }
    }

    if (blocks.length > 0) {
      return {
        source: 'ai',
        model: result.model,
        blocks,
        community: community.code,
        structure: communityStructureLabel(community),
      };
    }

    console.warn(
      '[ebau] La IA no devolvió bloques válidos; uso plantillas locales. Respuesta:',
      result.text.slice(0, 400)
    );
  } catch (error) {
    console.warn(
      '[ebau] Generación con IA no disponible; uso plantillas locales:',
      error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    );
  }

  return {
    source: 'local',
    blocks: localBlocks(topics, community),
    community: community.code,
    structure: communityStructureLabel(community),
  };
}

export interface GradeEbauInput {
  subjectName: string;
  communityCode?: string | null;
  blocks: ExamBlock[];
  answers: string[];
}

/**
 * Corrección cruzada: nota numérica, desglose por apartados y fallos de
 * notación. Devuelve `null` si la IA no está disponible para que el llamante
 * pase a autoevaluación guiada.
 */
export async function gradeEbauWithRubric(
  input: GradeEbauInput
): Promise<ExamGrade | null> {
  if (!(await hasAiProviderAsync())) return null;

  const community = getEbauCommunity(input.communityCode);

  const examText = input.blocks
    .map(
      (block, index) =>
        `BLOQUE ${index + 1} (máx ${block.points} pts) — «${block.topicTitle}»:\n${
          block.prompt
        }\n${
          block.apartados?.length ? `APARTADOS: ${block.apartados.join(' | ')}\n` : ''
        }RESPUESTA DEL ALUMNO: ${
          input.answers[index]?.trim() ? input.answers[index].trim() : '(en blanco)'
        }`
    )
    .join('\n\n');

  const systemInstruction = [
    `Eres corrector oficial de la EBAU de ${community.name} en «${input.subjectName}».`,
    `Corrige cada bloque sobre un máximo de ${community.pointsPerBlock} puntos con esta rúbrica: rigor conceptual 40%, desarrollo justificado 30%, resultado 20%, notación y unidades ${Math.round(
      community.notationWeight * 100
    )}%.`,
    'Sé exigente y justo como un corrector real: penaliza resultados sin justificar, unidades ausentes y errores de notación. Una respuesta en blanco puntúa 0.',
    'Aunque el alumno no haya separado los apartados, asígnales nota: el desglose es obligatorio.',
    'En `notationIssues` escribe cada fallo formal concreto (unidad ausente, signo, notación incorrecta). Si no hay, deja la lista vacía.',
    'En `feedback` escribe una crítica breve (2-3 frases) que diga exactamente qué falló y cómo se habría asegurado el punto.',
    'En `weakTopicTitles` lista solo los temas con puntuación por debajo del 60% del máximo.',
    'Devuelve EXCLUSIVAMENTE un JSON válido con este esquema:',
    '{"blocks":[{"index":0,"score":1.5,"notationIssues":["..."],"apartados":[{"label":"a","score":0.75,"max":1.25}],"feedback":"..."}],"weakTopicTitles":["tema"],"globalFeedback":"valoración global de 2-3 frases con nota final sobre 10"}',
    'Nada de texto fuera del JSON.',
  ].join('\n');

  try {
    const result = await runAiText({
      systemInstruction,
      message: `Corrige este simulacro EBAU:\n\n${examText}`,
      budgetMs: 75_000,
      attemptMs: 45_000,
    });

    const parsed = parseJsonLoose(result.text);
    if (!parsed) return null;

    const rawBlocks = Array.isArray(parsed.blocks) ? (parsed.blocks as unknown[]) : [];
    if (rawBlocks.length === 0) return null;

    const notationIssues: string[] = [];
    const blockResults: BlockResult[] = input.blocks.map((block, index) => {
      const found = rawBlocks
        .map((entry) => entry as Record<string, unknown>)
        .find((entry) => Number(entry.index) === index);
      const score = clamp(found?.score, 0, block.points) ?? 0;

      const issues = Array.isArray(found?.notationIssues)
        ? (found?.notationIssues as unknown[]).map(asString).filter((line) => line.length > 0)
        : [];
      for (const issue of issues) notationIssues.push(`Bloque ${index + 1}: ${issue}`);

      const apartados: ExamApartadoResult[] | undefined = Array.isArray(found?.apartados)
        ? (found?.apartados as unknown[])
            .map((entry) => entry as Record<string, unknown>)
            .map((entry) => ({
              label: asString(entry.label) || 'apartado',
              score: clamp(entry.score, 0, block.points) ?? 0,
              max: clamp(entry.max, 0, block.points) ?? 0,
            }))
            .filter((entry) => entry.max > 0)
            .slice(0, 6)
        : undefined;

      return {
        score: round4(score),
        max: block.points,
        feedback: asString(found?.feedback) || 'Sin comentario del corrector para este bloque.',
        notationIssues: issues.length > 0 ? issues : undefined,
        apartados: apartados && apartados.length > 0 ? apartados : undefined,
      };
    });

    const rawTotal = blockResults.reduce((total, block) => total + block.score, 0);
    const notationPenalty = Math.min(
      1,
      Math.round(notationIssues.length * community.notationPenalty * 100) / 100
    );
    const total = Math.max(0, Math.round((rawTotal - notationPenalty) * 100) / 100);

    const weakTopicTitles = Array.isArray(parsed.weakTopicTitles)
      ? (parsed.weakTopicTitles as unknown[]).map(asString).filter((title) => title.length > 0)
      : blockResults
          .map((block, index) =>
            block.score < block.max * EBAU_WEAK_BLOCK_RATIO
              ? input.blocks[index].topicTitle
              : ''
          )
          .filter((title) => title.length > 0);

    const globalFeedback =
      asString(parsed.globalFeedback) ||
      `Nota final del simulacro: ${total.toFixed(1)} / 10.`;

    return {
      mode: 'ai',
      total,
      blocks: blockResults,
      weakTopicTitles,
      globalFeedback:
        notationPenalty > 0
          ? `${globalFeedback}\n\nNotación: −${notationPenalty
              .toFixed(2)
              .replace('.', ',')} puntos por ${notationIssues.length} fallo(s) formal(es).`
          : globalFeedback,
      model: result.model,
      community: community.code,
      notationPenalty,
    };
  } catch (error) {
    console.warn(
      '[ebau] Corrección con IA no disponible; paso a autoevaluación:',
      error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    );
    return null;
  }
}

export interface AuditEbauInput {
  sessionId: string;
  subjectId: string;
  subjectName: string;
  community: string;
  blocks: ExamBlock[];
  results: BlockResult[];
}

/**
 * Convierte los fallos del simulacro en trabajo real:
 *   - una ficha por bloque flojo en el Banco de Errores,
 *   - una píldora de 15 min en el plan de hoy para cada unidad floja.
 *
 * Es idempotente por sesión: corregir dos veces el mismo simulacro no duplica
 * ni fichas ni píldoras.
 */
export async function auditEbauErrors(
  userId: string,
  input: AuditEbauInput
): Promise<ExamAudit> {
  const prisma = db(userId);
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(todayStart.getTime() + 86_400_000);

  let errorsCreated = 0;
  let pillsCreated = 0;

  const todayCount = await prisma.studyBlock.count({
    where: { date: { gte: todayStart, lt: todayEnd } },
  });

  for (let index = 0; index < input.blocks.length; index++) {
    const block = input.blocks[index];
    const result = input.results[index];
    if (!block?.topicId || !result) continue;

    const ratio = result.max > 0 ? result.score / result.max : 0;
    if (ratio >= EBAU_WEAK_BLOCK_RATIO) continue;

    const errorKey = `[simulacro EBAU] ${input.sessionId} · bloque ${index + 1}`;

    try {
      const existingError = await prisma.errorLog.findFirst({
        where: { questionPrompt: errorKey },
        select: { id: true },
      });

      if (!existingError) {
        await prisma.errorLog.create({
          data: {
            subjectId: input.subjectId,
            topicId: block.topicId,
            questionPrompt: errorKey,
            myAnswer: `Bloque corregido con ${round4(result.score)} / ${result.max} puntos en el simulacro de ${input.community}.`,
            correctAnswer:
              'Resolución completa, justificada y con la notación y unidades que exige el tribunal.',
            rootCause: 'concepto',
            keyLesson: result.feedback.slice(0, 900),
            correctiveAction:
              'Píldora de 15 minutos en el plan de hoy: reconstruir el concepto y repetir el bloque sin mirar la corrección.',
            reviewCount: 1,
            isMastered: false,
          },
        });
        errorsCreated += 1;
      }

      const existingPill = await prisma.studyBlock.findFirst({
        where: {
          topicId: block.topicId,
          date: { gte: todayStart, lt: todayEnd },
          reason: { contains: input.sessionId },
        },
        select: { id: true },
      });

      if (!existingPill) {
        await prisma.studyBlock.create({
          data: {
            topicId: block.topicId,
            date: todayStart,
            durationMinutes: EBAU_ERROR_PILL_MINUTES,
            technique: 'error_fix',
            mode: 'athlete',
            isCompleted: false,
            orderIndex: todayCount + pillsCreated + 1,
            objective: `Corregir el fallo de «${block.topicTitle}» del simulacro EBAU`,
            reason: `Píldora prioritaria del simulacro EBAU (${input.sessionId}): ${result.feedback.slice(0, 240)}`,
            material: 'Banco de Errores · corrección del simulacro',
            stage: 'correccion',
            breakMinutes: 5,
            status: 'pendiente',
            priorityScore: 92,
            origin: 'recuperacion',
            spentMinutes: 0,
          },
        });
        pillsCreated += 1;
      }
    } catch (error) {
      // La auditoría es un extra: si falla, la corrección sigue siendo válida.
      console.error('[ebau] no se pudo auditar el bloque', index + 1, error);
    }
  }

  return { errorsCreated, pillsCreated };
}
