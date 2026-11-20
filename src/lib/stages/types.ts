/**
 * Contratos de las etapas educativas.
 *
 * Todo lo que cambia entre ESO, Bachillerato y Universidad está aquí: escala de
 * calificación, herramientas visibles, valores por defecto del planificador y
 * fragmentos pedagógicos. El resto de la app NO debe escribir
 * `if (stage === 'ESO')`: pide la configuración a `src/lib/stages`.
 */

export type EducationStage = 'ESO' | 'BACHILLERATO' | 'UNIVERSIDAD';

export type StageScaleKind = 'sobre10' | 'sobre14';

export interface StageScale {
  kind: StageScaleKind;
  /** Nota máxima de la etapa (10 en ESO/Universidad, 14 en Bachillerato). */
  max: number;
  /** Etiqueta corta para la interfaz («Nota /10», «PAU /14»). */
  label: string;
  /** ¿Existe PAU/EBAU y tiene sentido el Examinador PAU? */
  hasPau: boolean;
}

export interface StageGradeLevel {
  /** Valor canónico que se guarda en `UserProfile.gradeLevel`. */
  key: string;
  label: string;
}

export interface StageTrack {
  /** Valor canónico que se guarda en `UserProfile.trackKey`. */
  key: string;
  label: string;
  /** Una línea para explicar a quién va dirigida la rama/modalidad. */
  hint: string;
}

export interface StageSubjectTemplate {
  name: string;
  color: string;
  /** Créditos ECTS orientativos; solo Universidad. */
  credits?: number;
}

export interface StagePlannerDefaults {
  capacityRatio: number;
  minBlockMin: number;
  maxBlocks: number;
}

export interface StageTools {
  /** Rutas que NO se pintan en la navegación (p. ej. el Examinador PAU). */
  hiddenHrefs: readonly string[];
  /** Etiqueta de la marca en la barra lateral. */
  navBadge: string;
}

export interface StageConfig {
  stage: EducationStage;
  /** Nombre de la etapa tal y como se lee en la interfaz. */
  label: string;
  scale: StageScale;
  planner: StagePlannerDefaults;
  gradeLevels: readonly StageGradeLevel[];
  tracks: readonly StageTrack[];
  tools: StageTools;
  supportsEcts: boolean;
  supportsConvocatorias: boolean;
  /** Personalidad base del Catedrático en esta etapa (sin la materia). */
  personality: string;
  /** Cómo se nombra la etapa cuando se habla de su nivel pedagógico. */
  pedagogyLabel: string;
}

/** Datos mínimos del perfil para resolver la etapa. */
export interface StageProfileLike {
  stage?: string | null;
  modality?: string | null;
  gradeLevel?: string | null;
  trackKey?: string | null;
  degreeName?: string | null;
}

/** Resumen serializable para el selector de Ajustes (server → client). */
export interface StageSummary {
  stage: EducationStage;
  label: string;
  gradeLevels: readonly StageGradeLevel[];
  tracks: readonly StageTrack[];
  supportsEcts: boolean;
  supportsConvocatorias: boolean;
  scaleLabel: string;
  hasPau: boolean;
}

/** Elección normalizada que se guarda en el perfil. */
export interface StageSelection {
  stage: EducationStage;
  gradeLevel: string;
  trackKey: string | null;
  degreeName: string | null;
  /** Cadena canónica que se escribe en `UserProfile.modality`. */
  modality: string;
}
