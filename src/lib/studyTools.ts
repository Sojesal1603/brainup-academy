/**
 * Herramientas de estudio on-demand del catedrático.
 *
 * El alumno pide desde el chat flashcards, un test, un mapa mental o una guía y
 * el catedrático los fabrica al vuelo. Este módulo es puro (sin Prisma ni red):
 *
 *   1. Define los cuatro formatos y sus metadatos para la interfaz.
 *   2. Monta el prompt que los genera, con la misma regla de fuentes que el
 *      tutor: nada que no esté en el temario, los apuntes o los documentos.
 *   3. Parsea y normaliza la respuesta del modelo. Un JSON roto o un test con
 *      opciones de menos no llega al alumno: se descarta y la ruta responde con
 *      un error honesto en vez de pintar una tarjeta vacía.
 *
 * La IA propone; el código valida. Igual que en `classCheckIn.ts`.
 */

export const STUDY_TOOL_KINDS = ['flashcards', 'test', 'mapa', 'guia'] as const;

export type StudyToolKind = (typeof STUDY_TOOL_KINDS)[number];

export function isStudyToolKind(value: unknown): value is StudyToolKind {
  return (
    typeof value === 'string' && (STUDY_TOOL_KINDS as readonly string[]).includes(value)
  );
}

/** Cómo se llama cada herramienta en la interfaz y qué hace. */
export const STUDY_TOOL_META: Record<
  StudyToolKind,
  { label: string; short: string; description: string }
> = {
  flashcards: {
    label: 'Flashcards',
    short: 'Flashcards',
    description: 'Tarjetas de recuerdo activo con pregunta, respuesta y fuente.',
  },
  test: {
    label: 'Test interactivo',
    short: 'Test',
    description: 'Preguntas tipo EBAU con corrección y explicación de cada fallo.',
  },
  mapa: {
    label: 'Mapa mental',
    short: 'Mapa',
    description: 'Jerarquía del tema en texto Mermaid para verla de un golpe.',
  },
  guia: {
    label: 'Guía de estudio',
    short: 'Guía',
    description: 'Resumen ejecutivo con lo que cae, las trampas y el plan de repaso.',
  },
};

export interface StudyToolTopic {
  title: string;
  unitNumber: number | null;
  status?: string;
  teacherMethod?: string | null;
}

export interface StudyToolInput {
  /** Qué herramienta se fabrica. */
  kind: StudyToolKind;
  agentName: string;
  specialty: string;
  subjectName: string;
  studentName: string;
  topic: StudyToolTopic;
  /** Lo que el alumno acaba de pedir en el chat (si lo hay). */
  focus: string | null;
  /** Líneas de contexto real ya montadas por quien llama (nivel, exámenes…). */
  context?: string[];
}

export interface Flashcard {
  front: string;
  back: string;
  source: string | null;
}

export interface QuizQuestion {
  question: string;
  options: string[];
  correctIndex: number;
  explanation: string;
  source: string | null;
}

export interface FlashcardsTool {
  kind: 'flashcards';
  title: string;
  notice: string | null;
  cards: Flashcard[];
}

export interface TestTool {
  kind: 'test';
  title: string;
  notice: string | null;
  questions: QuizQuestion[];
}

export interface MindMapTool {
  kind: 'mapa';
  title: string;
  notice: string | null;
  mermaid: string;
  summary: string;
}

export interface StudyGuideTool {
  kind: 'guia';
  title: string;
  notice: string | null;
  markdown: string;
}

export type StudyToolPayload = FlashcardsTool | TestTool | MindMapTool | StudyGuideTool;

/* ------------------------------------------------------------------ */
/* 1. El prompt                                                        */
/* ------------------------------------------------------------------ */

/** Qué tiene que devolver exactamente cada herramienta. */
const TOOL_SPECS: Record<StudyToolKind, string> = {
  flashcards: [
    'Genera 12 FLASHCARDS de recuerdo activo (sistema Leitner).',
    'Cada tarjeta: una sola pregunta directa y una respuesta inequívoca, sin rodeos. Si aplica, la fórmula en LaTeX entre $...$.',
    'Prohíbidas las preguntas de relleno («¿qué es este tema?») y las respuestas de más de 60 palabras.',
    'Cada tarjeta lleva su fuente (documento y página, apunte o unidad del temario). Si no hay fuente para una tarjeta, no la escribas.',
    'Estructura: {"title":"...","notice":null,"cards":[{"front":"...","back":"...","source":"..."}]}',
  ].join('\n'),
  test: [
    'Diseña un TEST de 8 preguntas de opción múltiple con 4 opciones (A-D) cada una, al estilo de la EBAU de esta materia.',
    'Mezcla 4 de concepto y 4 de aplicación o cálculo. Una sola opción correcta por pregunta.',
    'Cada pregunta lleva su explicación: por qué la correcta lo es y qué error esconde cada distractor, citando la fuente.',
    'Estructura: {"title":"...","notice":null,"questions":[{"question":"...","options":["...","...","...","..."],"correctIndex":0,"explanation":"...","source":"..."}]}',
    '`correctIndex` es el índice 0-3 de la opción correcta.',
  ].join('\n'),
  mapa: [
    'Construye un MAPA MENTAL del tema en sintaxis Mermaid válida, empezando por la palabra `mindmap` en la primera línea.',
    'Jerarquía de 3 niveles como máximo: raíz (la unidad), ramas (apartados) y hojas (conceptos y fórmulas clave).',
    'Nada de enlaces, estilos ni caracteres que rompan Mermaid: paréntesis solo en la raíz con la forma root((texto)).',
    'Estructura: {"title":"...","notice":null,"mermaid":"mindmap\\n  root((...))\\n    ...","summary":"una frase con la idea que ordena el tema"}',
  ].join('\n'),
  guia: [
    'Redacta una GUÍA DE ESTUDIO ejecutiva de 500-800 palabras en Markdown.',
    'Secciones obligatorias: `## Lo que cae en el examen`, `## Los 5 conceptos que no puedes fallar`, `## Fórmulas y reglas`, `## Errores que cuestan puntos` y `## Plan de repaso en 4 pasos`.',
    'Densa, sin relleno y con la fuente citada cuando una idea venga de un documento.',
    'Estructura: {"title":"...","notice":null,"markdown":"## ...\\n..."}',
  ].join('\n'),
};

/**
 * Prompt del generador. La regla de fuentes es la misma del tutor: el material
 * de estudio no se inventa ni se completa «de memoria cultural».
 */
export function buildStudyToolPrompt(input: StudyToolInput): {
  system: string;
  message: string;
} {
  const system = [
    `Eres ${input.agentName}, ${input.specialty} de Upgrade Academy (Bachillerato y EBAU, España).`,
    'Tu alumno te pide material de estudio y tú lo fabricas con rigor de cátedra, sin saludos ni explicaciones sobre lo que vas a hacer.',
    '',
    'REGLA DE FUENTES (no negociable):',
    '- Usa solo el temario, los apuntes y los documentos que tienes en el contexto. No inventes definiciones, fórmulas, fechas ni ejemplos.',
    '- Si un punto no está en el material, no lo rellenes: déjalo fuera o avísalo en `notice`.',
    '- Cada elemento lleva la fuente concreta (documento y página, apunte o unidad).',
    '',
    'FORMATO:',
    '- Responde ÚNICAMENTE con un objeto JSON válido, sin markdown alrededor y sin texto antes ni después.',
    '- Español de España, tuteo, notación correcta y LaTeX entre $...$ cuando haga falta.',
    '- Nada de contenido de relleno: si el tema no da para 12 flashcards honestas, entrega las que puedas y dilo en `notice`.',
    '',
    TOOL_SPECS[input.kind],
  ].join('\n');

  const unit = input.topic.unitNumber
    ? `U${input.topic.unitNumber} «${input.topic.title}»`
    : `«${input.topic.title}»`;

  const lines = [
    `Alumno: ${input.studentName}. Materia: ${input.subjectName}.`,
    `Unidad: ${unit}${input.topic.status ? ` (estado en clase: ${input.topic.status})` : ''}.`,
  ];

  if (input.topic.teacherMethod && input.topic.teacherMethod.trim().length > 0) {
    lines.push(
      `Metodología exigida por su profesor (prioridad absoluta en notación y criterios): «${input.topic.teacherMethod.trim()}».`
    );
  }

  if (input.focus && input.focus.trim().length > 0) {
    lines.push(`Lo que acaba de pedir en el chat: «${input.focus.trim().slice(0, 600)}».`);
  }

  if (input.context && input.context.length > 0) {
    lines.push('', 'CONTEXTO REAL DEL ALUMNO (lo único que sabes de él):');
    lines.push(...input.context.map((line) => `- ${line}`));
  }

  lines.push('', 'Devuelve solo el JSON con la estructura indicada.');

  return { system, message: lines.join('\n') };
}

/* ------------------------------------------------------------------ */
/* 2. Parseo y normalización                                           */
/* ------------------------------------------------------------------ */

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** El JSON, aunque el modelo lo envuelva en vallas o suelte texto alrededor. */
function extractJson(raw: string): Record<string, unknown> | null {
  const text = String(raw ?? '').replace(/```(?:json)?/gi, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;

  try {
    return asRecord(JSON.parse(text.slice(start, end + 1)));
  } catch {
    return null;
  }
}

function baseFields(data: Record<string, unknown> | null, kind: StudyToolKind): {
  title: string;
  notice: string | null;
} {
  return {
    title: asText(data?.title) || STUDY_TOOL_META[kind].label,
    notice: asText(data?.notice) || null,
  };
}

function parseCards(data: Record<string, unknown> | null): Flashcard[] {
  const list = Array.isArray(data?.cards) ? data.cards : [];
  const cards: Flashcard[] = [];

  for (const entry of list) {
    const card = asRecord(entry);
    if (!card) continue;
    const front = asText(card.front);
    const back = asText(card.back);
    if (front.length === 0 || back.length === 0) continue;
    cards.push({ front, back, source: asText(card.source) || null });
    if (cards.length >= 20) break;
  }

  return cards;
}

function parseCorrectIndex(question: Record<string, unknown>, options: string[]): number {
  const rawIndex = Number(question.correctIndex);
  if (Number.isInteger(rawIndex) && rawIndex >= 0 && rawIndex < options.length) return rawIndex;

  // Algunos modelos devuelven la letra en lugar del índice.
  const letter = asText(question.correct).toUpperCase();
  const index = ['A', 'B', 'C', 'D', 'E'].indexOf(letter);
  return index >= 0 && index < options.length ? index : -1;
}

function parseQuestions(data: Record<string, unknown> | null): QuizQuestion[] {
  const list = Array.isArray(data?.questions) ? data.questions : [];
  const questions: QuizQuestion[] = [];

  for (const entry of list) {
    const question = asRecord(entry);
    if (!question) continue;

    const text = asText(question.question);
    const options = Array.isArray(question.options)
      ? question.options.map((option) => asText(option)).filter((option) => option.length > 0)
      : [];
    const correctIndex = parseCorrectIndex(question, options);

    if (text.length === 0 || options.length < 2 || correctIndex < 0) continue;

    questions.push({
      question: text,
      options,
      correctIndex,
      explanation: asText(question.explanation) || 'Sin explicación del criterio de corrección.',
      source: asText(question.source) || null,
    });
    if (questions.length >= 12) break;
  }

  return questions;
}

/**
 * Convierte la respuesta cruda en la herramienta tipada. Devuelve `null` si el
 * material no sirve para estudiar: mejor un error que una tarjeta vacía.
 */
export function parseStudyToolPayload(
  kind: StudyToolKind,
  raw: string
): StudyToolPayload | null {
  const data = extractJson(raw);

  if (kind === 'flashcards') {
    const cards = parseCards(data);
    if (cards.length < 3) return null;
    return { kind, ...baseFields(data, kind), cards };
  }

  if (kind === 'test') {
    const questions = parseQuestions(data);
    if (questions.length < 3) return null;
    return { kind, ...baseFields(data, kind), questions };
  }

  if (kind === 'mapa') {
    const mermaid = (asText(data?.mermaid) || asText(data?.mindmap) || asText(data?.code))
      .replace(/```(?:mermaid)?/gi, '')
      .trim();
    if (!/^(mindmap|graph|flowchart)\b/i.test(mermaid)) return null;
    return {
      kind,
      ...baseFields(data, kind),
      mermaid,
      summary: asText(data?.summary),
    };
  }

  // La guía: si el modelo ignoró el JSON y devolvió Markdown puro, se acepta.
  const markdown = asText(data?.markdown);
  if (markdown.length >= 80) return { kind, ...baseFields(data, kind), markdown };

  const rawText = String(raw ?? '').replace(/```(?:markdown|md)?/gi, '').trim();
  if (rawText.length >= 200 && /^#{1,3}\s/m.test(rawText)) {
    return {
      kind,
      title: STUDY_TOOL_META.guia.label,
      notice: null,
      markdown: rawText,
    };
  }

  return null;
}
