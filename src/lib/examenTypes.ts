/**
 * Tipos compartidos del Examinador PAU.
 * Módulo puro (sin dependencias de servidor) para poder importarlo desde
 * componentes de cliente sin arrastrar Prisma al bundle.
 */

export interface ExamBlock {
  topicId: string | null;
  topicTitle: string;
  prompt: string;
  points: number;
}

export interface ExamPackage {
  source: 'ai' | 'local';
  model?: string;
  blocks: ExamBlock[];
}

export interface BlockResult {
  score: number;
  max: number;
  feedback: string;
}

export interface ExamGrade {
  mode: 'ai' | 'self';
  total: number;
  blocks: BlockResult[];
  weakTopicTitles: string[];
  globalFeedback: string;
  model?: string | null;
}
