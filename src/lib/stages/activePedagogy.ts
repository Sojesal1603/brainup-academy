import type { EducationStage } from './types';

/**
 * Pedagogía activa por etapa (Paso 11).
 *
 * El Catedrático deja de ser solo socrático reactivo: cada sesión conduce una
 * técnica de aprendizaje activo elegida por REGLAS, no por el modelo. La
 * elección es determinista (mismas entradas → misma técnica), así que se puede
 * probar y auditar sin gastar IA.
 *
 * Qué NO hace este módulo:
 * - No escribe `StudyBlock` ni toca el plan (eso es del Planificador).
 * - No cierra sesiones: el cierre lo confirma el alumno y lo ejecuta
 *   `sessionClose.ts` (Paso 10). Aquí solo se le pide al catedrático que deje
 *   el terreno preparado (qué falló y qué ideas merecen tarjeta).
 */

export type ActiveTechniqueKey =
  | 'recuperacion_error'
  | 'practica_recuperativa'
  | 'resolucion_guiada'
  | 'feynman'
  | 'intercalada'
  | 'socratica';

export interface ActiveTechnique {
  key: ActiveTechniqueKey;
  name: string;
  /** Por qué se ha elegido (una frase, para el informe del docente). */
  rationale: string;
  /** Pasos concretos que debe seguir el catedrático. */
  steps: readonly string[];
}

export interface TechniqueContext {
  stage: EducationStage;
  subjectName: string;
  /** Errores sin dominar del banco de esa materia. */
  pendingErrors: number;
  /** Unidades medidas por debajo del umbral (0–100). */
  weakUnits: number;
  /** Hay un examen en los próximos 7 días. */
  hasUpcomingExam: boolean;
  /** Minutos disponibles del bloque, si el plan los conoce. */
  minutes?: number | null;
}

/** Umbral compartido con `knowledge.ts` (una unidad floja está por debajo). */
export const WEAK_MASTERY = 60;

const TECHNIQUES: Record<ActiveTechniqueKey, ActiveTechnique> = {
  recuperacion_error: {
    key: 'recuperacion_error',
    name: 'Recuperación sobre errores reales',
    rationale: 'Hay fallos sin dominar: primero se recupera lo que ya falló, no materia nueva.',
    steps: [
      'Elige DOS errores del banco (los más repetidos) y plantea una pregunta corta de memoria, sin apuntes.',
      'Deja que responda antes de corregir; apunta si el fallo es de concepto, cálculo, lectura del enunciado o tiempo.',
      'Explica solo la causa raíz del fallo y pide un caso nuevo, parecido pero no idéntico.',
      'Cierra pidiéndole que nombre el error en una frase: es lo que se registrará al confirmar el cierre.',
    ],
  },
  practica_recuperativa: {
    key: 'practica_recuperativa',
    name: 'Práctica recuperativa',
    rationale: 'Hay unidades flojas medidas: recuperar activamente rinde más que releer.',
    steps: [
      'Empieza con tres preguntas de la unidad floja, de menor a mayor dificultad, sin dar la respuesta.',
      'Corrige cada intento nombrando el paso exacto que falla, no el resultado.',
      'Repite la misma idea en un formato distinto (numérico → gráfico → verbal) para comprobar transferencia.',
      'Termina con una pregunta de examen real de su curso sobre esa unidad.',
    ],
  },
  resolucion_guiada: {
    key: 'resolucion_guiada',
    name: 'Resolución guiada de problemas',
    rationale: 'Materia de cálculo o técnica: se aprende resolviendo, con el método visible.',
    steps: [
      'Haz un ejemplo resuelto completo, numerando pasos y justificando cada uno.',
      'Pide al alumno que resuelva uno casi igual, tapando el modelo, y espera su intento.',
      'Si se atasca, da la pista mínima del paso donde está, nunca el resultado final.',
      'Cierra con un problema de examen y una comprobación de unidades, orden de magnitud o coherencia.',
    ],
  },
  feynman: {
    key: 'feynman',
    name: 'Explicación tipo Feynman',
    rationale: 'Materia conceptual o humanística: se demuestra que se entiende explicándolo.',
    steps: [
      'Pídele que explique el concepto en tres frases, como si se lo contara a alguien que no lo ha estudiado.',
      'Detecta el término que usa sin definir y pídele que lo defina; ahí está el hueco real.',
      'Devuélvele una versión más precisa con el vocabulario de su profesor y su examen.',
      'Pídele que conecte el concepto con otro del temario (causa, consecuencia o contraste).',
    ],
  },
  intercalada: {
    key: 'intercalada',
    name: 'Práctica intercalada',
    rationale: 'Examen próximo: conviene alternar tipos de tarea para entrenar la discriminación.',
    steps: [
      'Alterna dos unidades o dos tipos de ejercicio, avisando del cambio de criterio.',
      'En cada cambio, pídele que diga qué tipo de problema es y qué método toca ANTES de resolver.',
      'Mezcla un ejercicio trampa o con dato irrelevante para entrenar la lectura del enunciado.',
      'Cierra con un mini-simulacro de 10 minutos con corrección inmediata.',
    ],
  },
  socratica: {
    key: 'socratica',
    name: 'Diálogo socrático dirigido',
    rationale: 'Sin señal de alarma: se diagnostica y se construye el concepto paso a paso.',
    steps: [
      'Diagnostica con una pregunta abierta: qué cree que es y dónde se atasca.',
      'Da pistas escalonadas y exige que justifique cada paso antes de avanzar.',
      'Introduce el formalismo después de que lo haya dicho con sus palabras.',
      'Cierra con una pregunta de examen y un resumen propio en dos líneas.',
    ],
  },
};

const STAGE_DEPTH: Record<EducationStage, string> = {
  ESO: 'Una sola idea por turno, frases cortas, ejemplos cotidianos y comprobación constante. No más de dos preguntas seguidas sin dejarle responder.',
  BACHILLERATO: 'Ritmo de examen: justificación formal, notación correcta y una pregunta de examen al cerrar cada bloque.',
  UNIVERSIDAD: 'Exige autonomía: que proponga el enfoque, cite la fuente y defienda el resultado. Corrige como un tribunal de Grado, con bibliografía y criterios de la guía docente.',
};

function subjectKind(subjectName: string): 'calculos' | 'humanidades' | 'idiomas' {
  const name = String(subjectName ?? '').toLowerCase();
  if (/inglés|ingles|francés|frances|alemán|aleman|idioma|lengua extranjera/.test(name)) {
    return 'idiomas';
  }
  if (/matem|álgebr|algebr|cálculo|calculo|físic|fisica|químic|quimic|tecnolog|ingenier|estadíst|estadist|contabilidad/.test(name)) {
    return 'calculos';
  }
  if (/lengua|literat|historia|filosof|geograf|arte|música|musica|latín|latin|derecho|econom/.test(name)) {
    return 'humanidades';
  }
  return 'calculos';
}

/** Técnica principal, determinista. */
export function pickTechnique(context: TechniqueContext): ActiveTechnique {
  const { stage, subjectName, pendingErrors, weakUnits, hasUpcomingExam } = context;
  const kind = subjectKind(subjectName);

  // 1. Los errores reales mandan sobre cualquier preferencia metodológica.
  if (pendingErrors >= 2) return TECHNIQUES.recuperacion_error;
  if (pendingErrors === 1 && stage !== 'ESO') return TECHNIQUES.recuperacion_error;

  // 2. Examen inminente: intercalar tipos de tarea.
  if (hasUpcomingExam && stage !== 'ESO') return TECHNIQUES.intercalada;

  // 3. Unidades flojas medidas.
  if (weakUnits > 0) {
    return kind === 'humanidades' ? TECHNIQUES.feynman : TECHNIQUES.practica_recuperativa;
  }

  // 4. Materia y etapa.
  if (kind === 'humanidades') return TECHNIQUES.feynman;
  if (kind === 'idiomas') return TECHNIQUES.practica_recuperativa;
  if (stage === 'ESO') return TECHNIQUES.socratica;
  return TECHNIQUES.resolucion_guiada;
}

/**
 * Secuencia corta de la sesión: técnica principal + una de contraste. La
 * segunda solo cambia si la primera es la socrática (para no repetir).
 */
export function pickTechniqueSequence(context: TechniqueContext): ActiveTechnique[] {
  const first = pickTechnique(context);
  const second =
    first.key === 'socratica'
      ? TECHNIQUES.practica_recuperativa
      : pickTechnique({ ...context, pendingErrors: 0, weakUnits: 0, hasUpcomingExam: false });
  return first.key === second.key ? [first] : [first, second];
}

/**
 * Capa de prompt que declara la técnica activa. Se inserta después de la capa
 * de etapa y antes del expediente: el modelo sabe QUÉ método debe conducir.
 */
export function buildActivePedagogyLayer(context: TechniqueContext): string[] {
  const [first, second] = pickTechniqueSequence(context);
  const lines: string[] = [];

  lines.push(
    `PEDAGOGÍA ACTIVA (Paso 11 · ${first.name}): esta sesión no es una explicación pasiva. Conduce la técnica y exige que el alumno produzca, no que escuche.`
  );
  lines.push(`Motivo de la elección: ${first.rationale}`);
  for (const [index, step] of first.steps.entries()) {
    lines.push(`${index + 1}. ${step}`);
  }
  if (second) {
    lines.push(
      `Si la sesión se alarga o el alumno se bloquea, cambia a «${second.name}»: ${second.steps[0]}`
    );
  }
  lines.push(`PROFUNDIDAD POR ETAPA: ${STAGE_DEPTH[context.stage]}`);
  if (typeof context.minutes === 'number' && context.minutes > 0) {
    lines.push(
      `Tiempo disponible: ${context.minutes} min. Si no da para la secuencia completa, recorta pasos, no el rigor.`
    );
  }
  lines.push(
    'CIERRE: cuando el alumno diga que ha terminado, resume en una línea qué se ha trabajado y pídele que confirme los fallos concretos y las 3–4 ideas que merecen tarjeta. El cierre y el plan los guarda la app cuando él lo confirma; no inventes que ya están guardados.'
  );

  return lines;
}
