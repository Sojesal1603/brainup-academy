/**
 * El coach pedagógico: lee patrones medidos y devuelve ajustes para el tutor.
 *
 * No es un juez que puntúa al alumno ni un prompt que se auto-modifica. Es una
 * capa determinista:
 *
 *   · solo cuenta lo que existe (errores, bloques, sesiones de foco, cierres);
 *   · si no hay denominador, no inventa un porcentaje;
 *   · traduce los patrones a instrucciones concretas para el catedrático;
 *   · el bloque que recibe el modelo es pequeño, silencioso y no se enseña al
 *     alumno como etiqueta.
 *
 * La persistencia y la lectura por usuario viven en `store.ts`; este archivo es
 * puro para poder probarlo sin base de datos.
 */
import { z } from 'zod';
import type { StudentState } from '../director/studentState';

export const COACH_VERSION = 1 as const;
export const COACH_SCOPE_PREFIX = 'coach:';

/** Ámbito estable por materia. Se acota para no guardar scopes arbitrarios. */
export function coachScope(subjectId: string): string {
  const clean = String(subjectId ?? '').trim().slice(0, 100);
  return `${COACH_SCOPE_PREFIX}${clean}`;
}

export type CoachConfidence = 'baja' | 'media' | 'alta';
export type CoachRigor = 'refuerzo' | 'equilibrado' | 'exigente';
export type CoachFocus =
  | 'concepto'
  | 'calculo'
  | 'enunciado'
  | 'autonomia'
  | 'habito'
  | 'equilibrado';
export type CoachSeverity = 'alta' | 'media' | 'baja';
export type CoachArea = 'base' | 'calculo' | 'enunciado' | 'autonomia' | 'tiempo' | 'carga';
export type CoachCause = 'concepto' | 'calculo' | 'lectura_enunciado' | 'tiempo' | 'bloqueo';

export type CoachSignalCode =
  | 'errores_concepto'
  | 'errores_calculo'
  | 'errores_lectura'
  | 'errores_tiempo'
  | 'errores_bloqueo'
  | 'errores_abiertos'
  | 'bloques_fallidos'
  | 'tiempo_efectivo_bajo'
  | 'interrupciones'
  | 'dependencia_tutor'
  | 'soluciones_directas'
  | 'tiempo_subestimado'
  | 'base_debil'
  | 'estancamiento'
  | 'sin_medicion';

export interface CoachErrorObservation {
  rootCause: string;
  isMastered: boolean;
  reviewCount?: number;
  topicTitle?: string;
}

export interface CoachBlockObservation {
  status: string;
  isCompleted: boolean;
  durationMinutes: number;
  spentMinutes: number;
}

export interface CoachFocusObservation {
  status: string;
  plannedMinutes: number;
  focusedSeconds: number;
  pausedSeconds?: number;
  tutorSeconds?: number;
  interruptions?: number;
}

export interface CoachOutcomeObservation {
  errorsCreated: number;
  directSolutionCount: number;
  reviewCardsCreated: number;
}

export interface CoachTopicObservation {
  id: string;
  title: string;
  mastery: number;
  measured: boolean;
}

export interface CoachEvidence {
  errorsObserved: number;
  errorsOpen: number;
  blocksObserved: number;
  blocksDecided: number;
  focusSessionsObserved: number;
  outcomesObserved: number;
  topicsObserved: number;
  topicsMeasured: number;
  dueReviews: number;
  total: number;
}

export interface CoachSignal {
  code: CoachSignalCode;
  severity: CoachSeverity;
  title: string;
  detail: string;
  count: number;
  total: number;
}

export interface CoachRecommendation {
  code: string;
  area: CoachArea;
  severity: CoachSeverity;
  title: string;
  instruction: string;
  evidence: string;
}

export interface CoachProfile {
  version: typeof COACH_VERSION;
  subjectId: string;
  subjectName: string;
  generatedAtIso: string;
  confidence: CoachConfidence;
  rigor: CoachRigor;
  explanationFocus: CoachFocus;
  baseTopics: string[];
  evidence: CoachEvidence;
  signals: CoachSignal[];
  recommendations: CoachRecommendation[];
  summary: string;
  promptBlock: string;
  fingerprint: string;
}

export interface CoachInput {
  subjectId: string;
  subjectName: string;
  generatedAtIso: string;
  errors: readonly CoachErrorObservation[];
  blocks: readonly CoachBlockObservation[];
  focus: readonly CoachFocusObservation[];
  outcomes: readonly CoachOutcomeObservation[];
  topics: readonly CoachTopicObservation[];
  /**
   * Foto mínima del `StudentState` ya calculado. Se usa para los agregados
   * exactos (errores abiertos, repasos y unidades); los detalles salen de las
   * observaciones. Si no se pasa, solo se usan las observaciones disponibles.
   */
  state?: Pick<StudentState, 'errorsOpen' | 'dueReviews' | 'units'>;
}

const CAUSE_META: Record<
  CoachCause,
  {
    label: string;
    signal: CoachSignalCode;
    area: CoachArea;
    recommendation: string;
    instruction: string;
  }
> = {
  concepto: {
    label: 'concepto',
    signal: 'errores_concepto',
    area: 'base',
    recommendation: 'reforzar_concepto',
    instruction:
      'Antes de un ejercicio nuevo, dedica dos minutos a la idea base y pide un ejemplo mínimo; no des la solución entera.',
  },
  calculo: {
    label: 'cálculo',
    signal: 'errores_calculo',
    area: 'calculo',
    recommendation: 'exigir_calculo',
    instruction:
      'Exige escribir los pasos intermedios y una comprobación final; corrige el primer error de cálculo antes de continuar.',
  },
  lectura_enunciado: {
    label: 'lectura del enunciado',
    signal: 'errores_lectura',
    area: 'enunciado',
    recommendation: 'trabajar_enunciado',
    instruction:
      'Haz que reformule el enunciado y subraye datos, condición y pregunta antes de calcular.',
  },
  tiempo: {
    label: 'gestión del tiempo',
    signal: 'errores_tiempo',
    area: 'tiempo',
    recommendation: 'gestionar_tiempo',
    instruction:
      'Divide la tarea en tramos cortos con un límite visible; en el primer tramo solo hay que identificar el método.',
  },
  bloqueo: {
    label: 'bloqueo',
    signal: 'errores_bloqueo',
    area: 'carga',
    recommendation: 'bajar_bloqueo',
    instruction:
      'Empieza con un ejemplo resuelto y una sola decisión; baja la carga y no des la respuesta completa.',
  },
};

function safeText(max: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !/[<>]/.test(value), 'El texto no puede contener HTML.');
}

const signalSchema = z.object({
  code: z.enum([
    'errores_concepto',
    'errores_calculo',
    'errores_lectura',
    'errores_tiempo',
    'errores_bloqueo',
    'errores_abiertos',
    'bloques_fallidos',
    'tiempo_efectivo_bajo',
    'interrupciones',
    'dependencia_tutor',
    'soluciones_directas',
    'tiempo_subestimado',
    'base_debil',
    'estancamiento',
    'sin_medicion',
  ]),
  severity: z.enum(['alta', 'media', 'baja']),
  title: safeText(120),
  detail: safeText(300),
  count: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

const recommendationSchema = z.object({
  code: safeText(60),
  area: z.enum(['base', 'calculo', 'enunciado', 'autonomia', 'tiempo', 'carga']),
  severity: z.enum(['alta', 'media', 'baja']),
  title: safeText(120),
  instruction: safeText(500),
  evidence: safeText(240),
});

const evidenceSchema = z.object({
  errorsObserved: z.number().int().nonnegative(),
  errorsOpen: z.number().int().nonnegative(),
  blocksObserved: z.number().int().nonnegative(),
  blocksDecided: z.number().int().nonnegative(),
  focusSessionsObserved: z.number().int().nonnegative(),
  outcomesObserved: z.number().int().nonnegative(),
  topicsObserved: z.number().int().nonnegative(),
  topicsMeasured: z.number().int().nonnegative(),
  dueReviews: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

/** Esquema para volver a leer un perfil guardado sin confiar en el JSON. */
export const coachProfileSchema = z.object({
  version: z.literal(COACH_VERSION),
  subjectId: safeText(80),
  subjectName: safeText(120),
  generatedAtIso: safeText(40),
  confidence: z.enum(['baja', 'media', 'alta']),
  rigor: z.enum(['refuerzo', 'equilibrado', 'exigente']),
  explanationFocus: z.enum(['concepto', 'calculo', 'enunciado', 'autonomia', 'habito', 'equilibrado']),
  baseTopics: z.array(safeText(100)).max(5),
  evidence: evidenceSchema,
  signals: z.array(signalSchema).max(16),
  recommendations: z.array(recommendationSchema).max(8),
  summary: safeText(600),
  promptBlock: z
    .string()
    .trim()
    .max(1800)
    .refine((value) => !/[<>]/.test(value), 'El prompt no puede contener HTML.'),
  fingerprint: safeText(40),
});

function roundNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function normalizeCause(raw: string): CoachCause | null {
  const value = String(raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

  if (value.includes('concept')) return 'concepto';
  if (value.includes('calcul')) return 'calculo';
  if (value.includes('lectura') || value.includes('enunciado')) return 'lectura_enunciado';
  if (value.includes('tiempo')) return 'tiempo';
  if (value.includes('bloque')) return 'bloqueo';
  return null;
}

function isCompletedBlock(block: CoachBlockObservation): boolean {
  return block.isCompleted || /complet/i.test(block.status);
}

function isFailedBlock(block: CoachBlockObservation): boolean {
  const status = String(block.status ?? '').toLowerCase();
  return !isCompletedBlock(block) && (status.includes('abandon') || status.includes('parcial'));
}

function severityRank(severity: CoachSeverity): number {
  return severity === 'alta' ? 0 : severity === 'media' ? 1 : 2;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

function hash(value: string): string {
  let h = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    h ^= value.charCodeAt(index);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function formatCount(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * Construye el perfil. Es determinista: el mismo contenido, en cualquier orden
 * de entrada y en cualquier momento, produce el mismo fingerprint.
 */
export function buildCoachProfile(input: CoachInput): CoachProfile {
  const errors = [...input.errors];
  const blocks = [...input.blocks];
  const focus = [...input.focus];
  const outcomes = [...input.outcomes];
  const topics = [...input.topics];

  const openErrors = errors.filter((error) => !error.isMastered);
  const decidedBlocks = blocks.filter((block) => isCompletedBlock(block) || isFailedBlock(block));
  const completedBlocks = decidedBlocks.filter(isCompletedBlock);
  const failedBlocks = decidedBlocks.filter(isFailedBlock);
  const focusObserved = focus.filter(
    (session) => String(session.status ?? '').toLowerCase() !== 'running' && session.plannedMinutes > 0
  );
  const measuredTopics = topics.filter((topic) => topic.measured);
  const weakTopics = measuredTopics
    .filter((topic) => Number.isFinite(topic.mastery) && topic.mastery <= 45)
    .sort((a, b) => a.mastery - b.mastery || a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
    .slice(0, 3);

  const errorsOpen = Math.max(roundNonNegative(input.state?.errorsOpen ?? 0), openErrors.length);
  const dueReviews = roundNonNegative(input.state?.dueReviews ?? 0);
  const unitsTotal = Math.max(roundNonNegative(input.state?.units.total ?? 0), topics.length);
  const unitsMeasured = Math.max(roundNonNegative(input.state?.units.measured ?? 0), measuredTopics.length);

  const evidence: CoachEvidence = {
    errorsObserved: errors.length,
    errorsOpen,
    blocksObserved: blocks.length,
    blocksDecided: decidedBlocks.length,
    focusSessionsObserved: focusObserved.length,
    outcomesObserved: outcomes.length,
    topicsObserved: topics.length,
    topicsMeasured: unitsMeasured,
    dueReviews,
    total:
      Math.max(openErrors.length, errorsOpen) +
      decidedBlocks.length +
      focusObserved.length +
      outcomes.length +
      weakTopics.length +
      (unitsTotal > 0 && unitsMeasured === 0 ? 1 : 0),
  };

  const signals: CoachSignal[] = [];
  const recommendations: CoachRecommendation[] = [];

  const addSignal = (signal: CoachSignal) => {
    if (signals.some((item) => item.code === signal.code)) return;
    signals.push(signal);
  };

  const addRecommendation = (recommendation: CoachRecommendation) => {
    if (recommendations.some((item) => item.code === recommendation.code)) return;
    recommendations.push(recommendation);
  };

  const causeCounts = new Map<CoachCause, number>();
  for (const error of openErrors) {
    const cause = normalizeCause(error.rootCause);
    if (cause) causeCounts.set(cause, (causeCounts.get(cause) ?? 0) + 1);
  }

  const sortedCauses = [...causeCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  for (const [cause, count] of sortedCauses) {
    const meta = CAUSE_META[cause];
    const share = openErrors.length > 0 ? count / openErrors.length : 0;
    const severity: CoachSeverity = count >= 3 || share >= 0.5 ? 'alta' : 'media';
    addSignal({
      code: meta.signal,
      severity,
      title: `Patrón de ${meta.label}`,
      detail: `${formatCount(count, 'error reciente', 'errores recientes')} de ${openErrors.length} abiertos se deben a ${meta.label}.`,
      count,
      total: openErrors.length,
    });
    addRecommendation({
      code: meta.recommendation,
      area: meta.area,
      severity,
      title: `Refuerza ${meta.label}`,
      instruction: meta.instruction,
      evidence: `${count}/${openErrors.length} errores abiertos de ${meta.label}`,
    });
  }

  if (errorsOpen >= 5 && sortedCauses.length === 0) {
    addSignal({
      code: 'errores_abiertos',
      severity: 'media',
      title: 'Errores acumulados',
      detail: `${errorsOpen} errores siguen abiertos y no hay un patrón de causa dominante.`,
      count: errorsOpen,
      total: errorsOpen,
    });
    addRecommendation({
      code: 'cerrar_errores',
      area: 'base',
      severity: 'media',
      title: 'Cierra antes de ampliar',
      instruction:
        'Dedica diez minutos a cerrar dos errores abiertos antes de introducir contenido nuevo; pide al alumno que explique qué falló.',
      evidence: `${errorsOpen} errores abiertos`,
    });
  }

  if (decidedBlocks.length >= 3) {
    const failureRate = failedBlocks.length / decidedBlocks.length;
    if (failureRate >= 0.3) {
      const severity: CoachSeverity = failureRate >= 0.5 ? 'alta' : 'media';
      addSignal({
        code: 'bloques_fallidos',
        severity,
        title: 'Bloques que no se cierran',
        detail: `${failedBlocks.length} de ${decidedBlocks.length} bloques decididos quedaron a medias o abandonados.`,
        count: failedBlocks.length,
        total: decidedBlocks.length,
      });
      addRecommendation({
        code: 'reducir_bloques',
        area: 'carga',
        severity,
        title: 'Bloques más pequeños',
        instruction:
          'Reduce el bloque a una sola meta de 10-15 minutos y cierra con una comprobación; no añadas una segunda tarea hasta terminar la primera.',
        evidence: `${failedBlocks.length}/${decidedBlocks.length} bloques sin cerrar`,
      });
    }
  }

  if (focusObserved.length >= 2) {
    const plannedSeconds = focusObserved.reduce(
      (total, session) => total + Math.max(0, session.plannedMinutes) * 60,
      0
    );
    const focusedSeconds = focusObserved.reduce(
      (total, session) => total + Math.max(0, session.focusedSeconds),
      0
    );
    const tutorSeconds = focusObserved.reduce(
      (total, session) => total + Math.max(0, session.tutorSeconds ?? 0),
      0
    );
    const interruptions = focusObserved.reduce(
      (total, session) => total + Math.max(0, session.interruptions ?? 0),
      0
    );

    if (plannedSeconds > 0) {
      const focusRatio = focusedSeconds / plannedSeconds;
      if (focusRatio < 0.55) {
        addSignal({
          code: 'tiempo_efectivo_bajo',
          severity: 'media',
          title: 'Poco tiempo efectivo',
          detail: `El foco real es ${Math.round(focusRatio * 100)}% del tiempo planificado en ${focusObserved.length} sesiones.`,
          count: Math.round(focusedSeconds / 60),
          total: Math.round(plannedSeconds / 60),
        });
        addRecommendation({
          code: 'bloques_cortos',
          area: 'tiempo',
          severity: 'media',
          title: 'Tramos más cortos',
          instruction:
            'Propón un tramo de 10-15 minutos con una sola pregunta y una pausa después; mide el logro por el tramo cerrado, no por el tiempo sentado.',
          evidence: `${Math.round(focusRatio * 100)}% de tiempo efectivo`,
        });
      }
    }

    const averageInterruptions = interruptions / focusObserved.length;
    if (averageInterruptions >= 1.5) {
      addSignal({
        code: 'interrupciones',
        severity: 'media',
        title: 'Interrupciones frecuentes',
        detail: `Hay ${averageInterruptions.toFixed(1)} interrupciones de media por sesión de foco.`,
        count: interruptions,
        total: focusObserved.length,
      });
      addRecommendation({
        code: 'modo_enfoque',
        area: 'tiempo',
        severity: 'media',
        title: 'Protege el foco',
        instruction:
          'Empieza con una instrucción única y pide que cierre pestañas y avisos; si se interrumpe, retoma en el mismo paso en vez de reiniciar.',
        evidence: `${averageInterruptions.toFixed(1)} interrupciones por sesión`,
      });
    }

    const tutorRatio =
      focusedSeconds > 0 ? tutorSeconds / focusedSeconds : tutorSeconds > 0 ? 1 : 0;
    if (tutorRatio >= 0.35) {
      addSignal({
        code: 'dependencia_tutor',
        severity: 'media',
        title: 'Demasiado tiempo en el tutor',
        detail: `El tiempo de consulta al tutor es ${Math.round(tutorRatio * 100)}% del tiempo de foco.`,
        count: Math.round(tutorSeconds / 60),
        total: Math.round(Math.max(1, focusedSeconds) / 60),
      });
      addRecommendation({
        code: 'pista_minima',
        area: 'autonomia',
        severity: 'media',
        title: 'Pista mínima, no solución',
        instruction:
          'No des la solución completa: da la pista mínima, pide un intento y corrige solo el primer paso fallido. Deja que el alumno cierre el ejercicio.',
        evidence: `${Math.round(tutorRatio * 100)}% del foco fue consulta`,
      });
    }
  }

  const completedWithTime = completedBlocks.filter(
    (block) => block.durationMinutes > 0 && block.spentMinutes > 0
  );
  if (completedWithTime.length >= 2) {
    const overrun = completedWithTime.filter(
      (block) => block.spentMinutes > block.durationMinutes * 1.25
    );
    if (overrun.length / completedWithTime.length >= 0.5) {
      addSignal({
        code: 'tiempo_subestimado',
        severity: 'media',
        title: 'Los bloques se alargan',
        detail: `${overrun.length} de ${completedWithTime.length} bloques completados superaron su duración prevista en más de un 25%.`,
        count: overrun.length,
        total: completedWithTime.length,
      });
      addRecommendation({
        code: 'ajustar_duracion',
        area: 'tiempo',
        severity: 'media',
        title: 'Ajusta la duración',
        instruction:
          'Planifica el bloque con un 20-25% más de margen o recorta el alcance; no prometas que cabe justo en el tiempo teórico.',
        evidence: `${overrun.length}/${completedWithTime.length} bloques se alargaron`,
      });
    }
  }

  const directSolutions = outcomes.reduce(
    (total, outcome) => total + roundNonNegative(outcome.directSolutionCount),
    0
  );
  if (directSolutions >= 2) {
    addSignal({
      code: 'soluciones_directas',
      severity: 'media',
      title: 'Soluciones directas',
      detail: `Hay ${directSolutions} cierres con respuesta directa: el alumno está recibiendo la solución antes de intentarlo.`,
      count: directSolutions,
      total: outcomes.length,
    });
    addRecommendation({
      code: 'pista_minima',
      area: 'autonomia',
      severity: 'media',
      title: 'Pista mínima, no solución',
      instruction:
        'No des la solución completa: da la pista mínima, pide un intento y corrige solo el primer paso fallido. Deja que el alumno cierre el ejercicio.',
      evidence: `${directSolutions} soluciones directas en ${outcomes.length} cierres`,
    });
  }

  if (weakTopics.length >= 2) {
    addSignal({
      code: 'base_debil',
      severity: 'alta',
      title: 'Base medida floja',
      detail: `${weakTopics.length} unidades medidas están en el 45% o menos de dominio: ${weakTopics.map((topic) => topic.title).join(', ')}.`,
      count: weakTopics.length,
      total: unitsMeasured,
    });
    addRecommendation({
      code: 'reforzar_base',
      area: 'base',
      severity: 'alta',
      title: 'Refuerzo de conceptos base',
      instruction:
        'Antes de avanzar, dedica cinco minutos a un concepto base de la unidad floja y compruébalo con un ejemplo mínimo. No des por sabido lo que no está medido.',
      evidence: `${weakTopics.length} unidades ≤45% de dominio`,
    });
  }

  if (errorsOpen >= 5 && weakTopics.length >= 2 && failedBlocks.length >= 1) {
    addSignal({
      code: 'estancamiento',
      severity: 'alta',
      title: 'Estancamiento medido',
      detail: `${errorsOpen} errores abiertos, ${weakTopics.length} unidades flojas y ${failedBlocks.length} bloque(s) sin cerrar apuntan al mismo atasco.`,
      count: errorsOpen,
      total: unitsMeasured,
    });
    addRecommendation({
      code: 'romper_estancamiento',
      area: 'base',
      severity: 'alta',
      title: 'Rompe el atasco con una sola unidad',
      instruction:
        'No añadas contenido nuevo: elige la unidad floja con más errores, explica la idea base con un ejemplo mínimo y cierra un ejercicio con corrección antes de pasar a otra.',
      evidence: `${errorsOpen} errores abiertos en ${weakTopics.length} unidades flojas`,
    });
  }

  if (unitsTotal > 0 && unitsMeasured === 0) {
    addSignal({
      code: 'sin_medicion',
      severity: 'baja',
      title: 'Sin medición de nivel',
      detail: 'Hay unidades, pero ninguna tiene un nivel medido: no se puede ajustar la exigencia como si se conociera.',
      count: 0,
      total: unitsTotal,
    });
    addRecommendation({
      code: 'diagnostico',
      area: 'base',
      severity: 'media',
      title: 'Mide antes de exigir',
      instruction:
        'Haz una pregunta de diagnóstico breve antes de decidir el nivel; si no hay medición, no afirmes que el alumno domina o falla un concepto.',
      evidence: `${unitsTotal} unidades, 0 medidas`,
    });
  }

  const supportSignals = new Set<CoachSignalCode>([
    'errores_concepto',
    'errores_bloqueo',
    'bloques_fallidos',
    'tiempo_efectivo_bajo',
    'interrupciones',
    'dependencia_tutor',
    'soluciones_directas',
    'base_debil',
    'estancamiento',
  ]);
  const needsSupport = signals.some((signal) => supportSignals.has(signal.code));
  const strongPerformance =
    decidedBlocks.length > 0 &&
    completedBlocks.length / decidedBlocks.length >= 0.8 &&
    errorsOpen <= 2 &&
    focusObserved.length >= 2;
  const rigor: CoachRigor = needsSupport ? 'refuerzo' : strongPerformance ? 'exigente' : 'equilibrado';

  const explanationFocus: CoachFocus = (() => {
    if (signals.some((signal) => signal.code === 'base_debil' || signal.code === 'errores_concepto')) {
      return 'concepto';
    }
    if (signals.some((signal) => signal.code === 'errores_calculo')) return 'calculo';
    if (signals.some((signal) => signal.code === 'errores_lectura')) return 'enunciado';
    if (
      signals.some(
        (signal) => signal.code === 'dependencia_tutor' || signal.code === 'soluciones_directas'
      )
    ) {
      return 'autonomia';
    }
    if (
      signals.some(
        (signal) =>
          signal.code === 'bloques_fallidos' ||
          signal.code === 'tiempo_efectivo_bajo' ||
          signal.code === 'interrupciones' ||
          signal.code === 'tiempo_subestimado'
      )
    ) {
      return 'habito';
    }
    return 'equilibrado';
  })();

  if (rigor !== 'equilibrado') {
    addRecommendation({
      code: 'ajuste_exigencia',
      area: 'base',
      severity: rigor === 'refuerzo' ? 'alta' : 'baja',
      title: rigor === 'refuerzo' ? 'Baja la entrada, sube el apoyo' : 'Mantén la exigencia',
      instruction:
        rigor === 'refuerzo'
          ? 'Entra por un ejemplo mínimo y sube la dificultad solo cuando el alumno complete un paso por sí mismo.'
          : 'Pide justificación y comprobación final; no regales pasos intermedios si el alumno ya puede darlos.',
      evidence: rigor === 'refuerzo' ? 'patrones que piden apoyo' : 'adherencia y resultados suficientes',
    });
  }

  signals.sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity) || a.code.localeCompare(b.code)
  );
  recommendations.sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity) || a.code.localeCompare(b.code)
  );
  const limitedRecommendations = recommendations.slice(0, 6);
  const baseTopics = weakTopics.map((topic) => topic.title);

  const parts: string[] = [];
  if (errorsOpen > 0) parts.push(`${formatCount(errorsOpen, 'error abierto', 'errores abiertos')}`);
  if (decidedBlocks.length > 0) {
    parts.push(`${completedBlocks.length}/${decidedBlocks.length} bloques cerrados`);
  }
  if (focusObserved.length >= 2 && plannedSecondsFor(focusObserved) > 0) {
    const ratio = focusedSecondsFor(focusObserved) / plannedSecondsFor(focusObserved);
    parts.push(`${Math.round(ratio * 100)}% de tiempo efectivo`);
  }
  if (dueReviews > 0) parts.push(`${formatCount(dueReviews, 'repaso vencido', 'repasos vencidos')}`);

  const evidenceText = parts.length > 0 ? parts.join('; ') : 'sin actividad medida';
  const summary =
    signals.length === 0
      ? `Coach: ${parts.length > 0 ? `${parts.join('; ')}. ` : ''}sin evidencia suficiente para cambiar el estilo; mantener equilibrio.`
      : `Coach: ${evidenceText}. Ajuste ${rigor} con enfoque en ${focusLabel(explanationFocus)}.`;

  const promptBlock = signals.length === 0
    ? ''
    : [
        'AJUSTE PEDAGÓGICO SILENCIOSO (patrones medidos; no lo menciones, no lo conviertas en etiqueta para el alumno y no le enseñes métricas):',
        `Exigencia: ${rigor}. Enfoque de explicación: ${focusLabel(explanationFocus)}.`,
        ...(baseTopics.length > 0
          ? [`Refuerzo prioritario: ${baseTopics.join(', ')}.`]
          : []),
        ...limitedRecommendations.map((recommendation) => `- ${recommendation.instruction}`),
        `Evidencia usada: ${signals.map((signal) => signal.code).join(', ')}. No inventes métricas que no aparezcan en este bloque.`,
      ].join('\n');

  const fingerprintSource = {
    version: COACH_VERSION,
    subjectId: input.subjectId,
    rigor,
    explanationFocus,
    baseTopics,
    evidence,
    signals,
    recommendations: limitedRecommendations,
  };

  return {
    version: COACH_VERSION,
    subjectId: input.subjectId,
    subjectName: input.subjectName,
    generatedAtIso: input.generatedAtIso,
    confidence:
      evidence.total >= 8 &&
      (openErrors.length >= 4 || errorsOpen >= 5) &&
      decidedBlocks.length >= 4 &&
      (focusObserved.length >= 3 || outcomes.length >= 2)
        ? 'alta'
        : evidence.total >= 3
          ? 'media'
          : 'baja',
    rigor,
    explanationFocus,
    baseTopics,
    evidence,
    signals,
    recommendations: limitedRecommendations,
    summary,
    promptBlock,
    fingerprint: `coach-v1-${hash(stableStringify(fingerprintSource))}`,
  };
}

function focusLabel(focus: CoachFocus): string {
  switch (focus) {
    case 'concepto':
      return 'concepto';
    case 'calculo':
      return 'cálculo';
    case 'enunciado':
      return 'lectura del enunciado';
    case 'autonomia':
      return 'autonomía';
    case 'habito':
      return 'hábito y tiempo';
    default:
      return 'equilibrio';
  }
}

function plannedSecondsFor(sessions: readonly CoachFocusObservation[]): number {
  return sessions.reduce((total, session) => total + Math.max(0, session.plannedMinutes) * 60, 0);
}

function focusedSecondsFor(sessions: readonly CoachFocusObservation[]): number {
  return sessions.reduce((total, session) => total + Math.max(0, session.focusedSeconds), 0);
}
