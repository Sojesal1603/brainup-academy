/**
 * Modo de trabajo del catedrático (Paso 14, B7).
 *
 * La categoría de materia dice CÓMO se trabaja esa asignatura; el modo dice QUÉ
 * se hace en esta consulta. Son ejes ortogonales: una materia de problemas puede
 * trabajarse en simulacro o en corrección. Este módulo es puro y no guarda
 * estado: el modo viaja con el turno y se aplica como capa de prompt.
 */

export const SUBJECT_MODES = [
  'DIAGNOSTICAR',
  'ENTRENAR',
  'SIMULACRO',
  'CORREGIR',
  'PREPARAR',
] as const;

export type SubjectMode = (typeof SUBJECT_MODES)[number];

export interface SubjectModeMeta {
  label: string;
  short: string;
  description: string;
}

export const SUBJECT_MODE_META: Record<SubjectMode, SubjectModeMeta> = {
  DIAGNOSTICAR: {
    label: 'Diagnosticar',
    short: 'Diagnóstico',
    description: 'Preguntas para encontrar el fallo real antes de explicar nada.',
  },
  ENTRENAR: {
    label: 'Entrenar',
    short: 'Entrenar',
    description: 'Práctica guiada: el alumno hace el trabajo y recibe pistas escalonadas.',
  },
  SIMULACRO: {
    label: 'Simulacro',
    short: 'Simulacro',
    description: 'Condiciones de examen, sin pistas ni correcciones a mitad.',
  },
  CORREGIR: {
    label: 'Corregir',
    short: 'Corregir',
    description: 'Corrección con rúbrica: qué está bien, qué falla y por qué.',
  },
  PREPARAR: {
    label: 'Preparar examen',
    short: 'Preparar',
    description: 'Plan de prioridades, fechas y repaso para una prueba concreta.',
  },
};

export function normalizeSubjectMode(value: unknown): SubjectMode | null {
  if (typeof value !== 'string') return null;
  const upper = value.trim().toUpperCase();
  return (SUBJECT_MODES as readonly string[]).includes(upper) ? (upper as SubjectMode) : null;
}

/** Capa de prompt del modo. Sin modo no se añade nada (paridad con antes). */
export function buildModeLayer(mode: SubjectMode | null | undefined): string[] {
  if (!mode) return [];

  const layers: Record<SubjectMode, string[]> = {
    DIAGNOSTICAR: [
      'MODO DE TRABAJO: DIAGNOSTICAR.',
      '- No expliques la teoría todavía ni des la solución: primero localiza el fallo.',
      '- Haz 3-5 preguntas cortas, de menor a mayor dificultad, y espera la respuesta.',
      '- Cuando el alumno falle, nombra el concepto exacto que falla y compruébalo con otra pregunta.',
    ],
    ENTRENAR: [
      'MODO DE TRABAJO: ENTRENAR.',
      '- Practica con el alumno: un paso por turno y el trabajo lo hace él.',
      '- Da pistas escalonadas (concepto → estrategia → primer paso), nunca el resultado completo.',
      '- Al cerrar un ejercicio, pide que explique el criterio que ha usado.',
    ],
    SIMULACRO: [
      'MODO DE TRABAJO: SIMULACRO.',
      '- Plantea como un examen real: tiempo, puntuación por apartado y sin ayudas.',
      '- No corrijas ni des pistas hasta que el alumno entregue o pida terminar.',
      '- Si pide ayuda a mitad, recuérdale que está en simulacro y ofrécele parar y pasar a entrenar.',
    ],
    CORREGIR: [
      'MODO DE TRABAJO: CORREGIR.',
      '- Corrige con rúbrica: puntos conseguidos, errores por tipo y nota razonada.',
      '- Cita la prueba concreta del texto o del cálculo; no reescribas todo por él.',
      '- Termina con el error que más le cuesta y un ejercicio mínimo para corregirlo.',
    ],
    PREPARAR: [
      'MODO DE TRABAJO: PREPARAR EXAMEN.',
      '- Ordena el estudio por peso, dificultad y fecha; di qué entra y qué no.',
      '- Convierte el temario en sesiones concretas con minutos y una prueba de control.',
      '- Si falta una fecha o un criterio, pregúntalo en vez de inventarlo.',
    ],
  };

  return ['', ...layers[mode]];
}
