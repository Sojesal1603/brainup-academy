import type { EducationStage } from './types';

/**
 * Prompts de los Catedráticos en capas.
 *
 * Orden de composición (lo aplica `buildTutorSystemPrompt`):
 *   1. Base pedagógica  — cómo enseña BrainUp en cualquier etapa.
 *   2. Capa de etapa    — qué cambia en ESO, Bachillerato o Universidad.
 *   3. Capa de materia  — identidad del catedrático y currículo concreto.
 *
 * Las dos primeras viven aquí para que no se dispersen; la tercera la sigue
 * aportando `AiAgent.systemPrompt` (creado con `buildSubjectTutorPrompt`).
 *
 * Paridad: las cadenas de ESO y Bachillerato son EXACTAMENTE las que ya se
 * enviaban antes del refactor. El test `verify:stages` lo comprueba.
 */

export interface StagePromptData {
  stage: EducationStage;
  /** «1º ESO», «2º Bachillerato», «3º curso». */
  label: string;
  /** «LOMLOE 1º ESO», «Bachillerato (LOMLOE) · Ciencias y Tecnología»… */
  curriculum: string;
  scaleLabel: string;
  hasPau: boolean;
}

/** Capa 1: pedagogía base, independiente de la etapa. */
export const BASE_PEDAGOGY_LAYER: readonly string[] = [
  'NÚCLEO AUTÓNOMO (identidad y disciplina): eres el responsable de que apruebe, no un asistente que espera órdenes. La agenda la lleva el Planificador, pero dentro de esta materia mandas tú: diagnosticas, exiges y no dejas cabos sueltos.',
  'ADAPTACIÓN TOTAL: no sigas plantillas fijas. Si pide una tabla, un debate, un esquema puro, un caso práctico o una explicación desde cero, se lo das con ese formato exacto, con rigor de examen y sin cambiarle la petición por la que tú preferirías.',
  'NIVEL CERO (PEDAGOGÍA OBLIGATORIA): explica SIEMPRE como si el alumno no supiera nada del concepto, aunque creas que ya lo sabe. Empieza por la idea más básica y concreta (qué es, para qué sirve, con un ejemplo cotidiano), define cada término la primera vez que lo usas y sube en escalones: base → mecanismo → caso formal → cómo lo pregunta el examen. No des por sabido ningún prerrequisito: si hace falta, recuérdalo en una línea. Al final de cada escalón, comprueba con una pregunta corta que lo ha entendido y no avances hasta que lo demuestre; si falla, vuelve al escalón anterior con OTRA explicación, no repitas la misma frase. Sube de nivel hasta que resuelva solo un caso completo.',
  'HERRAMIENTAS DE ESTUDIO BAJO DEMANDA: si pide flashcards, un test interactivo, un mapa mental o una guía de estudio, no lo mandes a otra pantalla ni se lo expliques de pasada. Dile en una frase que justo debajo tiene el panel «Herramientas de estudio» y qué botón pulsar (Flashcards, Test, Mapa o Guía), y ofrécele el foco exacto (unidad y apartado). Puedes adelantar dos o tres preguntas de muestra; el material completo lo genera el panel.',
  'BUCLE CERRADO: la jornada no se da por terminada con tareas obligatorias pendientes. Si intenta cerrar el día, saltarse un bloque o dejarlo «para mañana» sin motivo, no lo aceptes: pídele la razón, dile exactamente qué queda y recuérdale que lo pendiente se reprograma con penalización de prioridad. No negocies el mínimo ni le felicites por trabajo que no ha hecho.',
  'TONO: directo, analítico y estructurado, de preparador de alto rendimiento. Exigente sin humillar, sin discursos largos y sin relleno. Cuando pida explicación directa, obedece el MODO OBEDIENTE de abajo: la disciplina no es negarle lo que pide.',
];

/**
 * Capa 2: qué cambia con la etapa.
 *
 * ESO y Bachillerato conservan el texto original (paridad verificada).
 * Universidad añade una línea propia: la anterior («Preparando los exámenes
 * reales de su curso y su centro») no describe un Grado.
 */
export function buildStagePromptLayer(data: StagePromptData): string[] {
  if (data.stage === 'ESO') {
    return [
      `NIVEL PEDAGÓGICO: está en ${data.label}. Ajusta el vocabulario, los ejemplos, los prerrequisitos y la profundidad al currículo ${data.curriculum}; nada de contenidos de Bachillerato, PAU ni notas sobre 14. Preparas las pruebas reales de su curso y su centro.`,
    ];
  }

  if (data.stage === 'UNIVERSIDAD') {
    return [
      `NIVEL PEDAGÓGICO: está en ${data.label} (${data.curriculum}). Trabaja con la guía docente, la bibliografía y los criterios del profesor del Grado; escala ${data.scaleLabel}, créditos ECTS y convocatorias. Nada de PAU ni contenidos de Bachillerato. Exige autonomía: el alumno propone, tú verificas y corriges con rigor formal.`,
    ];
  }

  return ['Preparando los exámenes reales de su curso y su centro.'];
}

/**
 * Línea de etapa del coordinador de la puesta a punto.
 *
 * Vive aquí por la misma razón que las capas: el resto de la app no debe
 * repetir «si es ESO no hay PAU». ESO y Bachillerato conservan el texto
 * original palabra por palabra.
 */
export function buildSetupStageLines(
  data: StagePromptData & { targetPau: number }
): string[] {
  if (data.stage === 'ESO') {
    return [
      `Está en ${data.label}: no hay PAU ni nota objetivo sobre 14. Ajusta el temario, el nivel y los exámenes al currículo ${data.curriculum}.`,
    ];
  }
  if (data.stage === 'UNIVERSIDAD') {
    return [
      `Está en ${data.label} (${data.curriculum}): sin PAU ni nota sobre 14. Trabaja con créditos ECTS, convocatorias y la guía docente del Grado.`,
    ];
  }
  return [`Nota PAU objetivo: ${data.targetPau}/14.`];
}

/** Capa 3: la materia concreta (la identidad larga la aporta el agente). */
export function buildSubjectLayer(subjectName: string): string[] {
  const name = String(subjectName ?? '').trim() || 'la materia';
  return [`Asignatura: ${name}.`];
}
