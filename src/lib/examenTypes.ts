/**
 * Tipos compartidos del Examinador (PAU/EBAU).
 * Módulo puro (sin dependencias de servidor) para poder importarlo desde
 * componentes de cliente sin arrastrar Prisma al bundle.
 */

import type { BlockVerification } from './verify';

export interface ExamBlock {
  topicId: string | null;
  topicTitle: string;
  prompt: string;
  points: number;
  /** Desglose visible del bloque: «a) …», «b) …». */
  apartados?: string[];
}

export interface ExamPackage {
  source: 'ai' | 'local';
  model?: string;
  blocks: ExamBlock[];
  /** Código de la comunidad con la que se generó (madrid, cataluna…). */
  community?: string;
  /** Etiqueta legible: «Comunidad de Madrid · 90 min · 4 × 2,5 pts». */
  structure?: string;
}

export interface ExamApartadoResult {
  label: string;
  score: number;
  max: number;
}

/** Etiquetas de confianza de una transcripción manuscrita (cliente y servidor). */
export const TRANSCRIPTION_CONFIDENCE_LABELS = {
  alta: 'Lectura clara',
  media: 'Lectura con dudas',
  baja: 'Lectura poco fiable',
} as const;

export interface BlockResult {
  score: number;
  max: number;
  feedback: string;
  /** Nota de cada pasada del corrector (la nota final es su mediana). */
  scores?: number[];
  /** Fallos formales detectados: unidades, signos, notación… */
  notationIssues?: string[];
  /** Nota apartado a apartado, si el corrector la ha devuelto. */
  apartados?: ExamApartadoResult[];
  /**
   * Evidencia del motor determinista (Paso 12). Se muestra y se le da al
   * corrector, pero **no modifica la nota**: un fallo de verificación se marca.
   */
  verification?: BlockVerification;
}

export interface ExamAudit {
  errorsCreated: number;
  pillsCreated: number;
}

export interface ExamGrade {
  mode: 'ai' | 'self';
  total: number;
  blocks: BlockResult[];
  weakTopicTitles: string[];
  globalFeedback: string;
  model?: string | null;
  community?: string;
  /** Puntos descontados por notación (sobre 10). */
  notationPenalty?: number;
  /** Pasadas válidas del corrector que entraron en la mediana. */
  passes?: number;
  /** Qué se ha inyectado en el Banco de Errores y en el plan. */
  audit?: ExamAudit;
}
