/**
 * Punto de entrada único de las etapas educativas.
 *
 * Cualquier módulo que necesite saber si hay PAU, qué escala se usa o qué
 * materias base trae un curso debe importar de aquí, no repetir condicionales.
 */

export type {
  EducationStage,
  StageConfig,
  StageGradeLevel,
  StagePlannerDefaults,
  StageProfileLike,
  StageScale,
  StageSelection,
  StageSubjectTemplate,
  StageSummary,
  StageTools,
  StageTrack,
} from './types';

export {
  STAGE_CONFIGS,
  STAGE_SUMMARIES,
  buildModality,
  courseDisplayLabel,
  getStageConfig,
  inferStageFromModality,
  isEducationStage,
  isRecognizedModality,
  normalizeStageSelection,
  parseStage,
  stageConfig,
  subjectTemplatesFor,
} from './catalog';
