/**
 * Catálogo de cursos y materias base.
 *
 * `UserProfile.modality` sigue siendo el único campo que guarda el curso: este
 * módulo lo normaliza para que la cabecera, la barra lateral, la puesta a punto
 * y los Catedráticos IA hablen del curso real y no de un Bachillerato fijo.
 *
 * Solo 1º ESO trae materias base: al elegirlo en Ajustes se crean las nueve
 * asignaturas curriculares si todavía no existen. En Bachillerato las materias
 * dependen de la modalidad y del centro, así que se siguen montando en la
 * puesta a punto.
 */

export type CourseStage = 'ESO' | 'Bachillerato' | 'Otro';

export interface BaseSubject {
  name: string;
  color: string;
}

export interface CourseOption {
  /** Valor que se guarda en `UserProfile.modality`. */
  id: string;
  /** Cómo se nombra el curso en la interfaz. */
  label: string;
  stage: CourseStage;
  /** Currículo que recibe la IA para ajustar el nivel pedagógico. */
  curriculum: string;
  /** Materias curriculares que se crean al activar el curso (vacío = ninguna). */
  baseSubjects: readonly BaseSubject[];
}

/**
 * Materias curriculares base de 1º ESO (LOMLOE). Son las nueve comunes a todas
 * las comunidades; Religión y Tutoría quedan fuera porque no se estudian en la
 * app y cada centro las organiza a su manera.
 */
export const ESO_1_BASE_SUBJECTS: readonly BaseSubject[] = [
  { name: 'Lengua Castellana y Literatura', color: '#f59e0b' },
  { name: 'Matemáticas', color: '#3b82f6' },
  { name: 'Geografía e Historia', color: '#d97706' },
  { name: 'Biología y Geología', color: '#10b981' },
  { name: 'Inglés', color: '#8b5cf6' },
  { name: 'Tecnología y Digitalización', color: '#06b6d4' },
  { name: 'Educación Física', color: '#ef4444' },
  { name: 'Música', color: '#ec4899' },
  { name: 'Educación Plástica', color: '#a855f7' },
];

const ESO_1: CourseOption = {
  id: '1º ESO',
  label: '1º ESO',
  stage: 'ESO',
  curriculum: 'LOMLOE 1º ESO',
  baseSubjects: ESO_1_BASE_SUBJECTS,
};

const BACH_CIENCIAS: CourseOption = {
  id: '1º de Bachillerato (Ciencias y Tecnología)',
  label: '1º Bachillerato',
  stage: 'Bachillerato',
  curriculum: 'Bachillerato (LOMLOE)',
  baseSubjects: [],
};

const BACH_HUMANIDADES: CourseOption = {
  id: '1º de Bachillerato (Humanidades y Ciencias Sociales)',
  label: '1º Bachillerato',
  stage: 'Bachillerato',
  curriculum: 'Bachillerato (LOMLOE)',
  baseSubjects: [],
};

const BACH_2: CourseOption = {
  id: '2º de Bachillerato',
  label: '2º Bachillerato',
  stage: 'Bachillerato',
  curriculum: 'Bachillerato (LOMLOE)',
  baseSubjects: [],
};

/** Opciones que se ofrecen en Ajustes. */
export const COURSE_OPTIONS: readonly CourseOption[] = [
  ESO_1,
  BACH_CIENCIAS,
  BACH_HUMANIDADES,
  BACH_2,
];

const DEFAULT_MODALITY = BACH_CIENCIAS.id;

function clean(value: string | null | undefined): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** «1º de ESO», «1 ESO», «ESO»… → el curso ESO real. */
function parseEso(raw: string): CourseOption | null {
  if (!/\beso\b/i.test(raw)) return null;
  const match = raw.match(/(\d)\s*[ºª°]?\s*(?:de\s+)?eso\b/i);
  const level = match ? Number(match[1]) : 1;
  if (level !== 1) {
    return {
      id: `${level}º ESO`,
      label: `${level}º ESO`,
      stage: 'ESO',
      curriculum: `LOMLOE ${level}º ESO`,
      baseSubjects: [],
    };
  }
  return ESO_1;
}

/** Normaliza cualquier modalidad guardada a un curso con su currículo. */
export function resolveCourse(modality: string | null | undefined): CourseOption {
  const raw = clean(modality) || DEFAULT_MODALITY;

  const eso = parseEso(raw);
  if (eso) return eso;

  const bach = raw.match(/(\d)\s*[ºª°]?\s*(?:de\s+)?bachillerato\b/i);
  if (bach) {
    const level = Number(bach[1]);
    if (level === 1) {
      return /humanidades|sociales/i.test(raw) ? BACH_HUMANIDADES : BACH_CIENCIAS;
    }
    return BACH_2;
  }
  if (/bachillerato|pau|ebau/i.test(raw)) return BACH_CIENCIAS;

  return {
    id: raw,
    label: raw,
    stage: 'Otro',
    curriculum: raw,
    baseSubjects: [],
  };
}

/** Materias base del curso (ninguna en Bachillerato: las pone el alumno). */
export function baseSubjectsFor(course: CourseOption): readonly BaseSubject[] {
  return course.baseSubjects;
}

/** ¿El perfil es de ESO? Los elementos de PAU dejan de tener sentido. */
export function isEsoCourse(modality: string | null | undefined): boolean {
  return resolveCourse(modality).stage === 'ESO';
}

/** Nombre corto del curso («1º ESO», «1º Bachillerato»). */
export function courseLabel(modality: string | null | undefined): string {
  return resolveCourse(modality).label;
}

/** Currículo que se le pasa a la IA («LOMLOE 1º ESO»). */
export function curriculumLabel(modality: string | null | undefined): string {
  return resolveCourse(modality).curriculum;
}

/**
 * Personalidad del Catedrático según el curso. Se usa al crear una materia
 * nueva para que la IA no arrastre el enfoque PAU en un perfil de ESO.
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

  if (course.stage === 'ESO') {
    return `Eres el Catedrático de ${name} para ${course.label} (${course.curriculum}). Ajustas el nivel al currículo oficial de la ESO: explicas desde cero, con ejemplos cotidianos, no das por sabidos contenidos de cursos superiores y preparas las pruebas del curso sin enfoque PAU. Exiges rigor, preguntas socráticas y trabajo diario.`;
  }

  return `Eres el Catedrático especializado en ${name} para ${course.label}. Explicas con rigor, preguntas socráticas y enfoque de preparación pre-PAU.`;
}
