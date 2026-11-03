/**
 * Capa de honestidad del expediente.
 *
 * Regla que gobierna este archivo: **un dato que nadie ha medido no es un
 * dato**. Antes, cada unidad nacía con un 20% de dominio y cada asignatura con
 * una nota media «de fábrica»; los catedráticos IA leían eso y hablaban de tus
 * puntos flojos y de tu 7,5 como si fueran tuyos. Aquí se marca de dónde sale
 * cada número y todo lo que no está medido se trata como desconocido:
 *
 *   - Para el planificador, una unidad sin medir vale el punto medio (no se
 *     premia como si fuera un desastre ni se ignora como si estuviera dominada).
 *   - Para los catedráticos, una unidad sin medir no se puede calificar: se
 *     pregunta o se diagnostica, nunca se afirma.
 *
 * Módulo puro (solo tipos): se puede transpilar y probar de forma aislada.
 */

export type MasterySource = 'sin_medir' | 'autoevaluacion' | 'diagnostico' | 'sesion' | 'simulacro';
export type GradeSource = 'sin_medir' | 'declarada' | 'simulacro';

export const MASTERY_SOURCE_META: Record<
  MasterySource,
  { label: string; short: string; hint: string; badgeColor: string }
> = {
  sin_medir: {
    label: 'Sin medir',
    short: 'sin medir',
    hint: 'Nadie ha medido tu nivel en esta unidad: no se usa para juzgarte',
    badgeColor: 'bg-slate-500/10 text-slate-400 border-slate-500/30',
  },
  autoevaluacion: {
    label: 'Tu autoevaluación',
    short: 'autoevaluado',
    hint: 'Nivel que has declarado tú, sin examen',
    badgeColor: 'bg-sky-500/10 text-sky-400 border-sky-500/30',
  },
  diagnostico: {
    label: 'Diagnóstico del catedrático',
    short: 'diagnosticado',
    hint: 'Nivel estimado por el catedrático IA con tus respuestas',
    badgeColor: 'bg-violet-500/10 text-violet-400 border-violet-500/30',
  },
  sesion: {
    label: 'Sesión de estudio',
    short: 'medido',
    hint: 'Nivel actualizado al cerrar una sesión de estudio',
    badgeColor: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  },
  simulacro: {
    label: 'Simulacro corregido',
    short: 'simulacro',
    hint: 'Nivel medido en un simulacro PAU corregido por rúbrica',
    badgeColor: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
  },
};

export const GRADE_SOURCE_META: Record<
  GradeSource,
  { label: string; hint: string; badgeColor: string }
> = {
  sin_medir: {
    label: 'Nota sin declarar',
    hint: 'Todavía no nos has dicho qué nota llevas: la app no se la inventa',
    badgeColor: 'bg-slate-500/10 text-slate-400 border-slate-500/30',
  },
  declarada: {
    label: 'Nota declarada por ti',
    hint: 'Nota media que has declarado tú de esta asignatura',
    badgeColor: 'bg-sky-500/10 text-sky-400 border-sky-500/30',
  },
  simulacro: {
    label: 'Nota de simulacro',
    hint: 'Nota medida en simulacros corregidos, no declarada',
    badgeColor: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
  },
};

/** Dominio que se asume cuando no hay medición: ni flojo ni fuerte. */
export const NEUTRAL_MASTERY = 50;

/** Por debajo de esto consideramos que una unidad medida está floja. */
export const WEAK_THRESHOLD = 55;

export function isMasterySource(value: unknown): value is MasterySource {
  return typeof value === 'string' && value in MASTERY_SOURCE_META;
}

export function isGradeSource(value: unknown): value is GradeSource {
  return typeof value === 'string' && value in GRADE_SOURCE_META;
}

/** ¿Alguien ha medido esta unidad? */
export function isMeasured(source: unknown): boolean {
  return isMasterySource(source) && source !== 'sin_medir';
}

export interface MasteryView {
  measured: boolean;
  source: MasterySource;
  label: string;
  badgeColor: string;
  /** Nivel que se debe usar en cálculos (el real si está medido, el neutro si no). */
  effective: number;
}

/** Cómo mostrar (y calcular) el dominio real de una unidad. */
export function describeMastery(topic: {
  masteryLevel: number;
  masterySource?: string | null;
}): MasteryView {
  const source: MasterySource = isMasterySource(topic.masterySource) ? topic.masterySource : 'sin_medir';
  const measured = source !== 'sin_medir';
  return {
    measured,
    source,
    label: measured ? `${topic.masteryLevel}%` : 'sin medir',
    badgeColor: MASTERY_SOURCE_META[source].badgeColor,
    effective: measured ? topic.masteryLevel : NEUTRAL_MASTERY,
  };
}

/** Nivel a usar en cálculos: medido si existe, neutro si no. */
export function effectiveMastery(topic: { masteryLevel: number; masterySource?: string | null }): number {
  return describeMastery(topic).effective;
}

export interface GradeView {
  declared: boolean;
  source: GradeSource;
  label: string;
  badgeColor: string;
  /** Nota a usar en cálculos; `null` si nadie la ha declarado. */
  value: number | null;
}

/** Cómo mostrar la nota media de una asignatura sin inventarla. */
export function describeGrade(subject: {
  currentGrade: number;
  gradeSource?: string | null;
  targetGrade?: number | null;
}): GradeView {
  const source: GradeSource = isGradeSource(subject.gradeSource) ? subject.gradeSource : 'sin_medir';
  const declared = source !== 'sin_medir';
  return {
    declared,
    source,
    label: declared ? subject.currentGrade.toFixed(1) : 'sin declarar',
    badgeColor: GRADE_SOURCE_META[source].badgeColor,
    value: declared ? subject.currentGrade : null,
  };
}

export interface StudentLevelInput {
  subjectName: string;
  grade: { currentGrade: number; gradeSource?: string | null };
  targetGrade: number;
  /** Unidades medidas (cualquier origen distinto de «sin_medir»). */
  measuredTopics: Array<{ title: string; masteryLevel: number; unitNumber?: number | null; source?: string }>;
  /** Cuántas unidades siguen sin medir. */
  unmeasuredCount: number;
  /** La unidad que se está dando en clase según el temario (dato real, no medido). */
  courseUnit?: { title: string; unitNumber?: number | null; status?: string } | null;
}

/**
 * Líneas de expediente que recibe el catedrático. Es la única puerta por la que
 * entra el nivel del alumno en el prompt: si aquí no está medido, el catedrático
 * lee en su lugar la orden explícita de no afirmar nada y diagnosticarlo él.
 */
export function buildStudentLevelLines(input: StudentLevelInput): string[] {
  const lines: string[] = [];
  const grade = describeGrade({
    currentGrade: input.grade.currentGrade,
    gradeSource: input.grade.gradeSource,
  });

  if (grade.declared) {
    lines.push(
      `Nota media en la materia: ${grade.label} (${GRADE_SOURCE_META[grade.source].label.toLowerCase()}).`
    );
  } else {
    lines.push(
      'Nota media en la materia: SIN DECLARAR. No cites ninguna nota suya, no supongas por dónde va de nivel y no le felicites por notas que no conoces.'
    );
  }

  lines.push(`Objetivo declarado en la materia: ${input.targetGrade.toFixed(1)}/10.`);

  // El llamante solo entrega unidades medidas: aquí no se inventa ninguna.
  const measured = input.measuredTopics;
  const weak = measured.filter((topic) => topic.masteryLevel < WEAK_THRESHOLD);
  const strong = measured.filter((topic) => topic.masteryLevel >= WEAK_THRESHOLD);

  if (weak.length > 0) {
    lines.push(
      'Unidades con nivel MEDIDO por debajo de su objetivo: ' +
        weak
          .map(
            (topic) =>
              `«${topic.title}»${topic.unitNumber ? ` (U${topic.unitNumber})` : ''} ${topic.masteryLevel}%` +
              (topic.source ? ` [${topic.source}]` : '')
          )
          .join(', ') +
        '.'
    );
  }

  if (strong.length > 0) {
    lines.push(
      `Unidades medidas que ya lleva bien: ${strong.length} (${strong
        .slice(0, 3)
        .map((topic) => `«${topic.title}»`)
        .join(', ')}${strong.length > 3 ? '…' : ''}).`
    );
  }

  if (input.unmeasuredCount > 0) {
    lines.push(
      `Hay ${input.unmeasuredCount} unidad(es) de esta materia SIN MEDIR de su nivel. No las des por sabidas ni por flojas: si necesitas saberlo, pregúntale o ponle una pregunta corta de diagnóstico.`
    );
  }

  if (input.courseUnit) {
    lines.push(
      `Dato real de su clase (no medido, solo temario): está dando la unidad ${
        input.courseUnit.unitNumber ? `U${input.courseUnit.unitNumber} ` : ''
      }«${input.courseUnit.title}»${input.courseUnit.status ? ` (${input.courseUnit.status})` : ''}.`
    );
  }

  return lines;
}

export const LEVEL_TAG_INSTRUCTION =
  'Si en esta conversación compruebas con sus respuestas el nivel real de una unidad concreta del temario, cierra tu mensaje con una única etiqueta [[nivel:U<numero>=<0-100>]] (por ejemplo [[nivel:U4=55]]). Solo cuando lo hayas comprobado de verdad; si no, no la pongas. El sistema la anota como nivel medido por ti.';

export interface ParsedLevelTag {
  /** Texto visible, sin la etiqueta. */
  text: string;
  level: { unitNumber: number; mastery: number } | null;
}

/**
 * Extrae la etiqueta [[nivel:U4=55]] del final del mensaje y la quita del texto
 * visible. Se aceptan tanto «U4» como «4» y valores entre 0 y 100.
 */
export function parseLevelTag(raw: string): ParsedLevelTag {
  const match = raw.match(/\[\[\s*nivel\s*:\s*U?\s*(\d{1,2})\s*=\s*(\d{1,3})\s*\]\]\s*$/i);
  if (!match) return { text: raw, level: null };

  const unitNumber = Number(match[1]);
  const mastery = Number(match[2]);
  const text = raw.slice(0, match.index).trimEnd();

  if (unitNumber < 1 || mastery > 100) return { text, level: null };
  return { text, level: { unitNumber, mastery } };
}

/** Etiqueta legible para la UI cuando llega una medición nueva. */
export function describeNewMeasurement(unitNumber: number | null, mastery: number): string {
  return `Nivel registrado${unitNumber ? ` en la unidad ${unitNumber}` : ''}: ${mastery}% (medido por el catedrático)`;
}
