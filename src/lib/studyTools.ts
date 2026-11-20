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

import {
  SUBJECT_CATEGORY_META,
  type SubjectCategory,
} from './subjects/category';

export const STUDY_TOOL_KINDS = [
  'flashcards',
  'test',
  'mapa',
  'guia',
  'problemas',
  'laboratorio',
  'comentario',
  'idioma',
] as const;

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
    description: 'Preguntas con corrección y explicación de cada fallo.',
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
  problemas: {
    label: 'Problema resuelto',
    short: 'Problema',
    description: 'Un problema con método visible, unidades y solución comprobada.',
  },
  laboratorio: {
    label: 'Práctica de laboratorio',
    short: 'Laboratorio',
    description: 'Hipótesis, variables, procedimiento, datos y conclusión.',
  },
  comentario: {
    label: 'Comentario guiado',
    short: 'Comentario',
    description: 'Fragmento, estructura y análisis con pruebas del texto.',
  },
  idioma: {
    label: 'Práctica de idioma',
    short: 'Idioma',
    description: 'Tarea escrita, correcciones explicadas y vocabulario en contexto.',
  },
};

/**
 * Orden del panel: primero las herramientas propias de la categoría y después
 * las demás, para que el método de la materia esté a un clic y ninguna
 * herramienta desaparezca. Las aún no implementadas se omiten.
 */
export function studyToolOrder(category?: SubjectCategory | null): StudyToolKind[] {
  const preferred = SUBJECT_CATEGORY_META[category ?? 'GENERAL'].tools.filter(isStudyToolKind);
  const chosen = new Set(preferred);
  return [...preferred, ...STUDY_TOOL_KINDS.filter((kind) => !chosen.has(kind))];
}

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
  /** Categoría didáctica: ajusta el estilo del test, no su formato. */
  category?: SubjectCategory | null;
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
  /** Id de la tarjeta en el motor SM-2 (lo asigna el servidor al guardarla). */
  cardId?: string;
}

export interface QuizQuestion {
  question: string;
  options: string[];
  correctIndex: number;
  explanation: string;
  source: string | null;
  /** Id de la tarjeta SM-2 asociada a esta pregunta. */
  cardId?: string;
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

export interface ProblemStep {
  title: string;
  body: string;
}

/** Verificación del motor propio, ya calculada en el servidor. */
export interface ToolVerification {
  status: string;
  checks: Array<{ kind: string; status: string; detail: string }>;
}

export interface ProblemsTool {
  kind: 'problemas';
  title: string;
  notice: string | null;
  statement: string;
  steps: ProblemStep[];
  solution: string;
  /** La rellena la ruta al comprobar la solución con `verifyBlock`. */
  verification?: ToolVerification | null;
}

export interface LabTool {
  kind: 'laboratorio';
  title: string;
  notice: string | null;
  hypothesis: string;
  variables: {
    independent: string;
    dependent: string;
    controlled: string[];
  };
  materials: string[];
  procedure: string[];
  dataTable: { headers: string[]; rows: string[][] } | null;
  analysis: string;
  conclusion: string;
}

export interface CommentaryTool {
  kind: 'comentario';
  title: string;
  notice: string | null;
  fragment: string | null;
  sections: Array<{ heading: string; content: string }>;
  conclusion: string;
}

export interface LanguageTool {
  kind: 'idioma';
  title: string;
  notice: string | null;
  task: string;
  modelAnswer: string;
  corrections: Array<{
    original: string;
    corrected: string;
    type: string;
    explanation: string;
  }>;
  vocabulary: Array<{ term: string; meaning: string; example: string }>;
  practice: string[];
}

export type StudyToolPayload =
  | FlashcardsTool
  | TestTool
  | MindMapTool
  | StudyGuideTool
  | ProblemsTool
  | LabTool
  | CommentaryTool
  | LanguageTool;

/* ------------------------------------------------------------------ */
/* 1. El prompt                                                        */
/* ------------------------------------------------------------------ */

/** Cómo se reparte la aplicación en el test según el método de la materia. */
const TEST_APPLICATION: Record<SubjectCategory, string> = {
  PROBLEMAS: '4 de aplicación o cálculo, con datos, unidades y comprobación del resultado',
  LABORATORIO: '4 de interpretación de datos, diseño experimental o análisis de resultados',
  COMENTARIO: '4 de análisis de un fragmento o de una obra, con pruebas del texto',
  IDIOMA: '4 de uso de la lengua: gramática, vocabulario o comprensión en el idioma',
  EXPOSICION: '4 de análisis de una obra, una audición o un discurso',
  TECNICA: '4 de aplicación, cálculo o diseño, sin ejecutar el código en el servidor',
  GENERAL: '4 de aplicación',
};

function buildTestSpec(category: SubjectCategory): string {
  return [
    'Diseña un TEST de 8 preguntas de opción múltiple con 4 opciones (A-D) cada una, al estilo de la prueba que pondría su profesor.',
    `Mezcla 4 de concepto y ${TEST_APPLICATION[category]}. Una sola opción correcta por pregunta.`,
    'Cada pregunta lleva su explicación: por qué la correcta lo es y qué error esconde cada distractor, citando la fuente.',
    'Estructura: {"title":"...","notice":null,"questions":[{"question":"...","options":["...","...","...","..."],"correctIndex":0,"explanation":"...","source":"..."}]}',
    '`correctIndex` es el índice 0-3 de la opción correcta.',
  ].join('\n');
}

/** Qué tiene que devolver exactamente cada herramienta. */
const TOOL_SPECS: Record<Exclude<StudyToolKind, 'test'>, string> = {
  flashcards: [
    'Genera 12 FLASHCARDS de recuerdo activo (sistema Leitner).',
    'Cada tarjeta: una sola pregunta directa y una respuesta inequívoca, sin rodeos. Si aplica, la fórmula en LaTeX entre $...$.',
    'Prohíbidas las preguntas de relleno («¿qué es este tema?») y las respuestas de más de 60 palabras.',
    'Cada tarjeta lleva su fuente (documento y página, apunte o unidad del temario). Si no hay fuente para una tarjeta, no la escribas.',
    'Estructura: {"title":"...","notice":null,"cards":[{"front":"...","back":"...","source":"..."}]}',
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
  problemas: [
    'Resuelve UN problema representativo de la unidad, del nivel real del alumno, con el método visible.',
    'Estructura el método en pasos: datos y lo que se pide, modelo o ley que se aplica, desarrollo y comprobación (unidades, orden de magnitud, signo).',
    'Cada paso lleva su cuenta o su razonamiento, no solo el título. No te salte ninguno.',
    'La solución final va aislada y en LaTeX entre $...$; nada de «el resultado es el correcto» sin número.',
    'Estructura: {"title":"...","notice":null,"statement":"...","steps":[{"title":"...","body":"..."}],"solution":"..."}',
  ].join('\n'),
  laboratorio: [
    'Diseña UNA práctica de laboratorio realizable con material escolar, sobre la unidad actual.',
    'Declara hipótesis contrastable, variable independiente, dependiente y controladas; materiales y procedimiento numerado con medidas y repeticiones.',
    'Incluye una tabla de datos con cabeceras y filas de ejemplo (o vacía si el alumno debe medir), análisis de qué se calcula y conclusión ligada a la hipótesis.',
    'Si el material del centro no permite medir algo, dilo en `notice` en vez de inventar datos.',
    'Estructura: {"title":"...","notice":null,"hypothesis":"...","variables":{"independent":"...","dependent":"...","controlled":["..."]},"materials":["..."],"procedure":["..."],"dataTable":{"headers":["..."],"rows":[["..."]]},"analysis":"...","conclusion":"..."}',
  ].join('\n'),
  comentario: [
    'Prepara UN comentario guiado sobre un fragmento breve y real de la unidad (texto, obra, imagen o audición descrita).',
    'Incluye el fragmento si está en el material; si no, describe la obra y pide al alumno que pegue el texto. No inventes citas literales.',
    'Estructura el análisis en secciones (localización, estructura, rasgos con ejemplos del texto, intención) y cierra con una valoración razonada.',
    'Cada afirmación se apoya en una prueba concreta del fragmento: cita entre comillas o indica el elemento exacto.',
    'Estructura: {"title":"...","notice":null,"fragment":"... o null","sections":[{"heading":"...","content":"..."}],"conclusion":"..."}',
  ].join('\n'),
  idioma: [
    'Propón UNA tarea escrita en el idioma de la materia, al nivel real del alumno (sin audio ni pronunciación: todo va en texto).',
    'Incluye tu respuesta modelo, correcciones de errores típicos (original → corrección, tipo de error y explicación breve) y vocabulario en contexto.',
    'Las correcciones deben salir del temario o de la tarea; no inventes errores que el alumno no ha cometido.',
    'Añade 3-5 ejercicios cortos de práctica con la respuesta esperada en la explicación, no en el enunciado.',
    'Estructura: {"title":"...","notice":null,"task":"...","modelAnswer":"...","corrections":[{"original":"...","corrected":"...","type":"...","explanation":"..."}],"vocabulary":[{"term":"...","meaning":"...","example":"..."}],"practice":["..."]}',
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
    `Eres ${input.agentName}, ${input.specialty} de Upgrade Academy (España).`,
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
    input.kind === 'test'
      ? buildTestSpec(input.category ?? 'GENERAL')
      : TOOL_SPECS[input.kind],
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

function textList(value: unknown, max = 20): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => asText(entry))
    .filter((entry) => entry.length > 0)
    .slice(0, max);
}

function parseProblems(data: Record<string, unknown> | null): ProblemsTool | null {
  const statement = asText(data?.statement);
  const solution = asText(data?.solution);
  const steps: ProblemStep[] = [];

  if (Array.isArray(data?.steps)) {
    for (const entry of data.steps) {
      const step = asRecord(entry);
      if (!step) continue;
      const title = asText(step.title);
      const body = asText(step.body) || asText(step.content);
      if (title.length === 0 && body.length === 0) continue;
      steps.push({ title: title || `Paso ${steps.length + 1}`, body });
      if (steps.length >= 12) break;
    }
  }

  if (statement.length === 0 || solution.length === 0 || steps.length < 2) return null;
  return { kind: 'problemas', ...baseFields(data, 'problemas'), statement, steps, solution };
}

function parseLab(data: Record<string, unknown> | null): LabTool | null {
  const hypothesis = asText(data?.hypothesis);
  const procedure = textList(data?.procedure, 20);
  const conclusion = asText(data?.conclusion);
  const variables = asRecord(data?.variables);

  if (hypothesis.length === 0 || procedure.length < 3 || conclusion.length === 0) return null;

  let dataTable: LabTool['dataTable'] = null;
  const table = asRecord(data?.dataTable);
  if (table) {
    const headers = textList(table.headers, 8);
    const rows = Array.isArray(table.rows)
      ? table.rows
          .map((row) => textList(row, 8))
          .filter((row) => row.length > 0)
          .slice(0, 20)
      : [];
    if (headers.length >= 2) dataTable = { headers, rows };
  }

  return {
    kind: 'laboratorio',
    ...baseFields(data, 'laboratorio'),
    hypothesis,
    variables: {
      independent: asText(variables?.independent),
      dependent: asText(variables?.dependent),
      controlled: textList(variables?.controlled, 10),
    },
    materials: textList(data?.materials, 20),
    procedure,
    dataTable,
    analysis: asText(data?.analysis),
    conclusion,
  };
}

function parseCommentary(data: Record<string, unknown> | null): CommentaryTool | null {
  const sections: CommentaryTool['sections'] = [];

  if (Array.isArray(data?.sections)) {
    for (const entry of data.sections) {
      const section = asRecord(entry);
      if (!section) continue;
      const heading = asText(section.heading) || asText(section.title);
      const content = asText(section.content) || asText(section.body);
      if (heading.length === 0 || content.length === 0) continue;
      sections.push({ heading, content });
      if (sections.length >= 8) break;
    }
  }

  const conclusion = asText(data?.conclusion);
  if (sections.length < 2 || conclusion.length === 0) return null;

  return {
    kind: 'comentario',
    ...baseFields(data, 'comentario'),
    fragment: asText(data?.fragment) || null,
    sections,
    conclusion,
  };
}

function parseLanguage(data: Record<string, unknown> | null): LanguageTool | null {
  const task = asText(data?.task);
  const modelAnswer = asText(data?.modelAnswer);
  if (task.length === 0 || modelAnswer.length === 0) return null;

  const corrections: LanguageTool['corrections'] = [];
  if (Array.isArray(data?.corrections)) {
    for (const entry of data.corrections) {
      const correction = asRecord(entry);
      if (!correction) continue;
      const original = asText(correction.original);
      const corrected = asText(correction.corrected);
      if (original.length === 0 || corrected.length === 0) continue;
      corrections.push({
        original,
        corrected,
        type: asText(correction.type) || 'error',
        explanation: asText(correction.explanation),
      });
      if (corrections.length >= 15) break;
    }
  }

  const vocabulary: LanguageTool['vocabulary'] = [];
  if (Array.isArray(data?.vocabulary)) {
    for (const entry of data.vocabulary) {
      const item = asRecord(entry);
      if (!item) continue;
      const term = asText(item.term);
      if (term.length === 0) continue;
      vocabulary.push({
        term,
        meaning: asText(item.meaning),
        example: asText(item.example),
      });
      if (vocabulary.length >= 15) break;
    }
  }

  if (corrections.length === 0 && vocabulary.length < 3) return null;

  return {
    kind: 'idioma',
    ...baseFields(data, 'idioma'),
    task,
    modelAnswer,
    corrections,
    vocabulary,
    practice: textList(data?.practice, 8),
  };
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

  if (kind === 'problemas') return parseProblems(data);
  if (kind === 'laboratorio') return parseLab(data);
  if (kind === 'comentario') return parseCommentary(data);
  if (kind === 'idioma') return parseLanguage(data);

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
