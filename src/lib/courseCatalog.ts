/**
 * Catálogo de cursos y materias base.
 *
 * `UserProfile.modality` sigue siendo el campo que guarda el curso exacto. Este
 * módulo lo normaliza a una etapa (`ESO` | `BACHILLERATO` | `UNIVERSIDAD`), un
 * curso y una rama/modalidad, y devuelve las materias base que trae ese curso.
 *
 * Las reglas de cada etapa (escala, PAU, herramientas, planificador y
 * personalidad) viven en `src/lib/stages/`; aquí solo se traduce el texto que
 * hay guardado a esa configuración. No dupliques condicionales por etapa fuera
 * de estos dos módulos.
 */

import {
  buildModality,
  getStageConfig,
  inferStageFromModality,
  stageConfig,
  subjectTemplatesFor,
  type EducationStage,
  type StageSubjectTemplate,
} from './stages';

export type CourseStage = EducationStage;

export interface BaseSubject {
  name: string;
  color: string;
  /** Créditos ECTS orientativos (solo Universidad). */
  credits?: number;
}

export interface CourseOption {
  /** Valor canónico que se guarda en `UserProfile.modality`. */
  id: string;
  /** Cómo se nombra el curso en la interfaz. */
  label: string;
  stage: EducationStage;
  /** "1º ESO", "2º Bachillerato", "3º curso". */
  gradeLevel: string;
  /** Modalidad de Bachillerato o rama universitaria. */
  trackKey: string | null;
  /** Etiqueta legible de la modalidad/rama. */
  trackLabel: string | null;
  /** Titulación editable; solo Universidad. */
  degreeName: string | null;
  /** Currículo que recibe la IA para ajustar el nivel pedagógico. */
  curriculum: string;
  /** Materias curriculares que se crean al activar el curso (vacío = ninguna). */
  baseSubjects: readonly BaseSubject[];
}

/**
 * Materias curriculares base de 1º ESO (LOMLOE). Son las nueve comunes a todas
 * las comunidades; Religión y Tutoría quedan fuera porque no se estudian en la
 * app y cada centro las organiza a su manera.
 *
 * Se conserva esta constante porque ya la usa el código existente y porque 1º
 * ESO no puede cambiar: el catálogo multi-etapa devuelve la misma lista.
 */
export const ESO_1_BASE_SUBJECTS: readonly BaseSubject[] =
  subjectTemplatesFor({ stage: 'ESO', gradeLevel: '1º ESO' });

const DEFAULT_MODALITY = '1º de Bachillerato (Ciencias y Tecnología)';

function clean(value: string | null | undefined): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function toBaseSubject(template: StageSubjectTemplate): BaseSubject {
  return template.credits === undefined
    ? { name: template.name, color: template.color }
    : { name: template.name, color: template.color, credits: template.credits };
}

/** Normaliza cualquier modalidad guardada a un curso con su currículo. */
export function resolveCourse(modality: string | null | undefined): CourseOption {
  const raw = clean(modality);
  const selection = inferStageFromModality(raw || DEFAULT_MODALITY);
  const config = stageConfig(selection.stage);
  const track = config.tracks.find((option) => option.key === selection.trackKey) ?? null;

  // Texto que no es ESO, Bachillerato ni Universidad: se respeta literalmente
  // (etapa por defecto, sin herramientas de PAU especiales) en vez de inventar
  // un curso que el alumno no ha elegido.
  const recognized = /eso|bachillerato|pau|ebau|universidad|universitari|\bgrado\b/i.test(raw);
  if (raw && !recognized) {
    return {
      id: raw,
      label: raw,
      stage: 'BACHILLERATO',
      gradeLevel: selection.gradeLevel,
      trackKey: null,
      trackLabel: null,
      degreeName: null,
      curriculum: raw,
      baseSubjects: [],
    };
  }

  const baseSubjects = subjectTemplatesFor({
    stage: selection.stage,
    gradeLevel: selection.gradeLevel,
    trackKey: selection.trackKey,
  }).map(toBaseSubject);

  let curriculum: string;
  if (selection.stage === 'ESO') {
    curriculum = `LOMLOE ${selection.gradeLevel}`;
  } else if (selection.stage === 'UNIVERSIDAD') {
    curriculum = [selection.degreeName ?? 'Grado', track?.label, selection.gradeLevel]
      .filter(Boolean)
      .join(' · ');
  } else {
    curriculum = track
      ? `Bachillerato (LOMLOE) · ${track.label}`
      : 'Bachillerato (LOMLOE)';
  }

  return {
    id: selection.modality || raw,
    label: selection.gradeLevel,
    stage: selection.stage,
    gradeLevel: selection.gradeLevel,
    trackKey: selection.trackKey,
    trackLabel: track?.label ?? null,
    degreeName: selection.degreeName,
    curriculum,
    baseSubjects,
  };
}

/** Todas las combinaciones que se ofrecen en Ajustes, ya normalizadas. */
export const COURSE_OPTIONS: readonly CourseOption[] = [
  '1º ESO',
  '2º ESO',
  '3º ESO',
  '4º ESO',
  buildModality({ stage: 'BACHILLERATO', gradeLevel: '1º Bachillerato', trackKey: 'ciencias' }),
  buildModality({ stage: 'BACHILLERATO', gradeLevel: '1º Bachillerato', trackKey: 'humanidades' }),
  buildModality({ stage: 'BACHILLERATO', gradeLevel: '1º Bachillerato', trackKey: 'general' }),
  '2º de Bachillerato',
  buildModality({ stage: 'BACHILLERATO', gradeLevel: '2º Bachillerato', trackKey: 'ciencias' }),
  buildModality({ stage: 'BACHILLERATO', gradeLevel: '2º Bachillerato', trackKey: 'humanidades' }),
  buildModality({ stage: 'BACHILLERATO', gradeLevel: '2º Bachillerato', trackKey: 'general' }),
].map((modality) => resolveCourse(modality));

/** Materias base del curso (Bachillerato no trae: dependen del centro). */
export function baseSubjectsFor(course: CourseOption): readonly BaseSubject[] {
  return course.baseSubjects;
}

/** ¿El perfil es de ESO? Los elementos de PAU dejan de tener sentido. */
export function isEsoCourse(modality: string | null | undefined): boolean {
  return resolveCourse(modality).stage === 'ESO';
}

/** ¿Tiene sentido el Examinador PAU en este curso? */
export function hasPauTools(modality: string | null | undefined): boolean {
  return getStageConfig({ modality }).scale.hasPau;
}

/** Nombre corto del curso («1º ESO», «1º Bachillerato», «2º curso»). */
export function courseLabel(modality: string | null | undefined): string {
  return resolveCourse(modality).label;
}

/** Currículo que se le pasa a la IA («LOMLOE 1º ESO»). */
export function curriculumLabel(modality: string | null | undefined): string {
  return resolveCourse(modality).curriculum;
}

/**
 * Personalidad del Catedrático según el curso. Se usa al crear una materia
 * nueva para que la IA no arrastre el enfoque PAU en ESO ni en Universidad.
 *
 * El curso puede llegar como modalidad guardada o como `CourseOption` ya
 * resuelto (lo habitual al crear materias base).
 */
export function buildSubjectTutorPrompt(
  subjectName: string,
  modalityOrCourse: string | CourseOption | null | undefined
): string {
  const course =
    typeof modalityOrCourse === 'object' && modalityOrCourse !== null
      ? modalityOrCourse
      : resolveCourse(modalityOrCourse);
  const name = clean(subjectName) || 'la materia';
  const config = stageConfig(course.stage);

  if (course.stage === 'BACHILLERATO') {
    // Paridad exacta con el prompt que ya se guardaba antes del refactor.
    return `Eres el Catedrático especializado en ${name} para ${course.label}. Explicas con rigor, preguntas socráticas y enfoque de preparación pre-PAU.`;
  }

  return `Eres el Catedrático de ${name} para ${course.label} (${course.curriculum}). ${config.personality}`;
}
