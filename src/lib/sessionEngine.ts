/**
 * Motor de sesiones: cuánto se estudia, qué se hace y por qué.
 *
 * Este módulo sustituye la idea de «bloques de 45 minutos» por sesiones de
 * duración variable que encajan en el tiempo REAL del día. Es puro (sin Prisma,
 * sin red, sin reloj de sistema: la fecha entra por parámetro) para poder
 * probarlo aislado y para que la pantalla, el planificador y el vigilante no
 * puedan calcular cosas distintas.
 *
 * Hace cinco cosas:
 *
 *   1. **Duraciones permitidas** (10-15, 25, 40-50, 60-90) y su descanso. Nada
 *      de 25/5 impuesto a todo: 15 minutos de flashcards no necesitan 5 de
 *      descanso, y 90 de simulacro necesitan más que 5.
 *   2. **Estimación por fases** de cada unidad: comprensión inicial, práctica
 *      activa, repaso espaciado, corrección de errores y simulacro. Cada una
 *      con su cuenta y su motivo, no un «6 horas» de cajón.
 *   3. **Calibración con el historial**: si un tipo de sesión te lleva de verdad
 *      más minutos de los estimados, la estimación futura sube (y baja si te
 *      lleva menos). Se mide con sesiones reales, no con optimismo.
 *   4. **Encaje exacto**: reparte el tiempo disponible en sesiones que caben,
 *      sin pasarse nunca del presupuesto y sin dejar huecos inútiles.
 *   5. **Repaso FSRS**: probabilidad de recuerdo, estabilidad y dificultad por
 *      unidad, con la fecha siguiente calculada para ~90% de recuerdo (y para
 *      el examen, que es la fecha que de verdad importa).
 */

import type { StudyTechnique } from './types';

/* ------------------------------------------------------------------ */
/* 1. Duraciones permitidas y descansos                                 */
/* ------------------------------------------------------------------ */

export type SessionBucket = 'micro' | 'estandar' | 'profundo' | 'intensivo';

export const SESSION_BUCKETS: Record<
  SessionBucket,
  { label: string; hint: string; badgeColor: string }
> = {
  micro: {
    label: 'Micro-sesión',
    hint: 'Repaso rápido, flashcards, mini-quiz o consolidación',
    badgeColor: 'bg-cyan-500/10 text-cyan-300 border-cyan-500/30',
  },
  estandar: {
    label: 'Sesión estándar',
    hint: 'Enfoque normal de 25 minutos',
    badgeColor: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
  },
  profundo: {
    label: 'Bloque profundo',
    hint: 'Tema nuevo, práctica profunda o corrección de errores',
    badgeColor: 'bg-blue-500/10 text-blue-300 border-blue-500/30',
  },
  intensivo: {
    label: 'Bloque intensivo',
    hint: 'Solo con tiempo, energía y necesidad: simulacro o preparación intensiva',
    badgeColor: 'bg-purple-500/10 text-purple-300 border-purple-500/30',
  },
};

/** Las únicas duraciones que el motor puede proponer. */
export const SESSION_LENGTHS = [10, 15, 25, 40, 50, 60, 90] as const;

/** La sesión más corta que merece la pena: por debajo, no se propone nada. */
export const MIN_SESSION_MINUTES = 10;

export function bucketForMinutes(minutes: number): SessionBucket {
  if (minutes <= 15) return 'micro';
  if (minutes <= 25) return 'estandar';
  if (minutes <= 50) return 'profundo';
  return 'intensivo';
}

/**
 * Descanso que toca tras una sesión de esta duración.
 *
 * Las micro-sesiones llevan un descanso corto **opcional** (3 min): parar diez
 * minutos después de quince de flashcards rompe el ritmo más de lo que ayuda.
 */
export function breakForMinutes(minutes: number): number {
  if (minutes <= 15) return 3;
  if (minutes <= 25) return 5;
  if (minutes <= 50) return 9;
  return 15;
}

/** ¿Se puede meter una sesión de esta duración en el tiempo que queda? */
export function fitsInBudget(minutes: number, availableMinutes: number): boolean {
  return minutes >= MIN_SESSION_MINUTES && minutes <= availableMinutes;
}

/** Energía disponible: cambia lo que se propone a las 22:00 y un sábado. */
export type EnergyLevel = 'alta' | 'media' | 'baja';

export function energyForMoment(now: Date, isWeekend: boolean): EnergyLevel {
  const hour = now.getHours();
  if (hour >= 21) return 'baja';
  if (isWeekend && hour >= 9 && hour <= 13) return 'alta';
  if (hour >= 16 && hour <= 20) return 'media';
  return 'media';
}

/* ------------------------------------------------------------------ */
/* 2. Estimación del trabajo por fases                                  */
/* ------------------------------------------------------------------ */

export type SessionStage = 'comprension' | 'practica' | 'repaso' | 'correccion' | 'simulacro';

export const SESSION_STAGES: Record<
  SessionStage,
  {
    label: string;
    short: string;
    /** Técnica activa que le corresponde. */
    technique: StudyTechnique;
    hint: string;
  }
> = {
  comprension: {
    label: 'Comprensión inicial',
    short: 'Comprender',
    technique: 'active_recall',
    hint: 'Primera pasada: entender y reconstruir sin mirar',
  },
  practica: {
    label: 'Práctica activa',
    short: 'Practicar',
    technique: 'problemas',
    hint: 'Ejercicios y problemas del tipo que cae en el examen',
  },
  repaso: {
    label: 'Repaso espaciado',
    short: 'Repasar',
    technique: 'srs_review',
    hint: 'Recuperar lo que está a punto de olvidarse',
  },
  correccion: {
    label: 'Corrección de errores',
    short: 'Corregir',
    technique: 'error_fix',
    hint: 'Volver sobre los fallos del banco de errores',
  },
  simulacro: {
    label: 'Simulacro',
    short: 'Simulacro',
    technique: 'simulacro',
    hint: 'Prueba cronometrada en condiciones reales',
  },
};

/** Lo que sabemos de la unidad. Todo opcional: se estima con lo que haya. */
export interface WorkSignals {
  /** Páginas del tema en el libro o los apuntes. */
  pages?: number | null;
  /** Diapositivas del profesor. */
  slides?: number | null;
  /** Conceptos, fórmulas o definiciones que hay que memorizar. */
  concepts?: number | null;
  /** Ejercicios o problemas del tema. */
  exercises?: number | null;
  /** Minutos de clase dedicados al tema (lo que ya se ha explicado). */
  classMinutes?: number | null;
}

export interface WorkEstimate {
  comprension: number;
  practica: number;
  repaso: number;
  correccion: number;
  simulacro: number;
  /** Suma sin calibrar (minutos). */
  rawTotal: number;
  /** Suma calibrada con tu historial: lo que de verdad se planifica. */
  total: number;
  /** Multiplicador aplicado (1 = la estimación se cumple). */
  calibration: number;
  /** Qué se ha supuesto por falta de datos, dicho en voz alta. */
  assumptions: string[];
}

export interface WorkEstimateInput {
  difficulty: number;
  /** Dominio efectivo (0-100). Si no está medido, `measured` es false. */
  mastery: number;
  measured: boolean;
  errorsOpen: number;
  /** Días hasta el examen de la materia (`null` = no hay examen). */
  daysToExam: number | null;
  /** Peso de la materia en la PAU (0.2 / 0.1 / 0). */
  examWeight: number;
  targetGrade: number;
  /** Minutos que ya se le han dedicado (para no volver a cobrarlos). */
  minutesAlready?: number;
  /** Multiplicador aprendido del historial por tipo de sesión. */
  calibration?: number;
  signals?: WorkSignals;
}

function round5(value: number): number {
  return Math.max(0, Math.round(value / 5) * 5);
}

/**
 * Estima el trabajo que queda en una unidad, **separado por fases**.
 *
 * La base sale de un volumen de contenido: páginas, diapositivas, conceptos,
 * ejercicios y minutos de clase. Lo que no se sabe no se inventa: se usa una
 * base por unidad y se apunta en `assumptions` («sin páginas: base por unidad»).
 * Sobre esa base pesan la dificultad (1-5), el nivel actual (o su ausencia), los
 * errores abiertos y la proximidad/peso del examen.
 */
export function estimateTopicWork(input: WorkEstimateInput): WorkEstimate {
  const difficulty = clampNumber(input.difficulty, 1, 5, 3);
  const assumptions: string[] = [];
  const signals = input.signals ?? {};

  // Volumen de contenido. Lo que falta, a la base por unidad (y se dice).
  const pages = signals.pages ?? 0;
  const slides = signals.slides ?? 0;
  const concepts = signals.concepts ?? 0;
  const exercises = signals.exercises ?? 0;
  const classMinutes = Math.max(0, signals.classMinutes ?? 0);

  if (!signals.pages && !signals.slides) assumptions.push('sin páginas ni diapositivas: base por unidad');
  if (!signals.concepts) assumptions.push('sin conceptos anotados: base por unidad');
  if (!signals.exercises) assumptions.push('sin ejercicios anotados: base por unidad');

  // Base: una unidad de dificultad 3 sin datos son unos 130 minutos de contenido.
  const baseContent = 130 + (difficulty - 3) * 25;

  const contentMinutes =
    baseContent +
    pages * 1.4 +
    slides * 0.5 +
    concepts * 2.5 +
    exercises * 3.5 +
    classMinutes * 0.15;

  // Dificultad (1-5) y nivel. Un tema sin medir no es «flojo»: se le da el
  // punto neutro (igual que hace `effectiveMastery`), ni 0% ni 100%.
  const diffFactor = 1 + (difficulty - 3) * 0.28;
  const mastery = input.measured ? clampNumber(input.mastery, 0, 100, 50) : 50;
  const levelFactor = 0.55 + ((100 - mastery) / 100) * 1.1;

  // El examen manda: su proximidad y su peso suben la práctica y el simulacro.
  const days = input.daysToExam;
  const examNear = days !== null ? Math.max(0, 1 - Math.min(days, 21) / 21) : 0;
  const weightFactor = 1 + (input.examWeight > 0 ? 0.25 : 0);
  const targetFactor = clampNumber(input.targetGrade, 5, 10, 7) / 7;

  const adjusted = contentMinutes * diffFactor * levelFactor * weightFactor;

  // 1. Comprensión inicial: se paga una vez, y menos si ya se ha visto en clase.
  const classDiscount = classMinutes > 0 ? Math.max(0.55, 1 - classMinutes / 600) : 1;
  let comprension = adjusted * 0.42 * classDiscount;

  // 2. Práctica activa: lo que más pesa, y más aún cerca del examen.
  let practica = adjusted * 0.5 * (1 + examNear * 0.35);

  // 3. Repaso espaciado: presupuesto aparte, no de hoy (se reparte en semanas).
  const repaso = adjusted * 0.3 * (1 + examNear * 0.2);

  // 4. Corrección de errores: los fallos abiertos son minutos concretos. Sin
  // errores abiertos NO hay fase de corrección (antes quedaba un «Cerrar 0
  // errores» que ocupaba la primera sesión del día, que es absurdo).
  const correccion =
    input.errorsOpen > 0
      ? input.errorsOpen * (12 + difficulty * 2.5) + adjusted * 0.05
      : 0;

  // 5. Simulacro: solo cuando el examen está cerca y la materia pondera.
  const simulacro =
    days !== null && days <= 10 && input.examWeight > 0
      ? 90 * (0.8 + examNear * 0.4)
      : days !== null && days <= 5
        ? 60
        : 0;

  // Lo ya hecho en esta unidad no se vuelve a cobrar (se descuenta de la
  // comprensión y la práctica, que es donde se gastó).
  const already = Math.max(0, input.minutesAlready ?? 0);
  if (already > 0) {
    const discount = Math.min(0.9, already / Math.max(60, comprension + practica));
    comprension *= 1 - discount;
    practica *= 1 - discount;
  }

  const calibration = clampCalibration(input.calibration ?? 1);

  const raw = {
    comprension: round5(comprension),
    practica: round5(practica),
    repaso: round5(repaso),
    correccion: round5(correccion),
    simulacro: round5(simulacro),
  };

  const rawTotal = raw.comprension + raw.practica + raw.repaso + raw.correccion + raw.simulacro;

  const total =
    round5(raw.comprension * calibration) +
    round5(raw.practica * calibration) +
    round5(raw.repaso * calibration) +
    round5(raw.correccion * calibration) +
    raw.simulacro; // el simulacro es una prueba cronometrada: no se «calibra»

  return {
    ...raw,
    rawTotal,
    total: Math.max(MIN_SESSION_MINUTES, total),
    calibration,
    assumptions,
  };
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/* ------------------------------------------------------------------ */
/* 3. Calibración con el historial                                      */
/* ------------------------------------------------------------------ */

/** Un dato de la realidad: cuánto se planificó y cuánto se tardó. */
export interface CalibrationSample {
  technique: string;
  plannedMinutes: number;
  spentMinutes: number;
}

/** Límites: el historial ajusta, no secuestra la estimación. */
export const CALIBRATION_MIN = 0.6;
export const CALIBRATION_MAX = 1.8;
/** Con menos muestras que esto, un dato suelto no cambia nada. */
export const CALIBRATION_MIN_SAMPLES = 3;

export function clampCalibration(value: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(CALIBRATION_MAX, Math.max(CALIBRATION_MIN, Math.round(n * 100) / 100));
}

/**
 * Cuánto se desvía la realidad de la estimación, por tipo de sesión.
 *
 * Se usa la mediana de las últimas muestras (no la media): una sesión cortada a
 * los dos minutos no debe convencer al sistema de que todo se hace en la mitad
 * de tiempo. Con menos de `CALIBRATION_MIN_SAMPLES` muestras devuelve 1: sin
 * historial no hay nada aprendido, y fingir que sí sería peor que no calibrar.
 */
export function calibrationByTechnique(
  samples: CalibrationSample[],
  fallback: number = 1
): Record<string, number> {
  const grouped = new Map<string, number[]>();

  for (const sample of samples) {
    const planned = Number(sample.plannedMinutes);
    const spent = Number(sample.spentMinutes);
    if (!Number.isFinite(planned) || !Number.isFinite(spent)) continue;
    if (planned < MIN_SESSION_MINUTES || spent < 1) continue;
    // Una sesión no puede durar 40 veces lo previsto: eso es un temporizador
    // olvidado, no un dato de calibración.
    const ratio = spent / planned;
    if (ratio < 0.25 || ratio > 4) continue;
    const key = String(sample.technique ?? 'otro');
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(ratio);
  }

  const out: Record<string, number> = {};
  for (const [technique, ratios] of grouped) {
    if (ratios.length < CALIBRATION_MIN_SAMPLES) continue;
    out[technique] = clampCalibration(median(ratios));
  }

  return { default: clampCalibration(fallback), ...out };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Multiplicador que toca aplicar a una técnica concreta. */
export function calibrationFor(
  calibration: Record<string, number>,
  technique: string
): number {
  return clampCalibration(calibration[technique] ?? calibration.default ?? 1);
}

/* ------------------------------------------------------------------ */
/* 4. Prioridad y encaje en el tiempo disponible                         */
/* ------------------------------------------------------------------ */

export interface PlanCandidate {
  topicId: string;
  topicTitle: string;
  subjectId: string;
  subjectName: string;
  subjectColor: string;
  /** Más alto = antes. Se calcula en `scoreCandidate`. */
  priority: number;
  /** Trabajo que queda, por fase (minutos). */
  work: WorkEstimate;
  difficulty: number;
  mastery: number;
  measured: boolean;
  daysToExam: number | null;
  examWeight: number;
  examTitle: string | null;
  dueReview: boolean;
  overdueDays: number;
  /** Probabilidad de recuerdo hoy (0-100) o `null` si nunca se ha repasado. */
  retention: number | null;
  /** Probabilidad de recuerdo el día del examen, si lo hay. */
  retentionAtExam: number | null;
  errorsOpen: number;
  /** Estado en el temario: pendiente / en_curso / visto / repasado. */
  status: string;
  /** Ya se ha explicado en clase. */
  seen: boolean;
  /** Entrega de Moodle de esa materia, si la hay. */
  taskDays: number | null;
  /** La materia se da en clase mañana: prepararla hoy rinde más. */
  classNextDay: boolean;
  /** La unidad se ha explicado HOY en clase: máxima prioridad del día. */
  seenToday?: boolean;
}

export interface ScoreInput {
  daysToExam: number | null;
  examWeight: number;
  measured: boolean;
  mastery: number;
  errorsOpen: number;
  difficulty: number;
  dueReview: boolean;
  overdueDays: number;
  retention: number | null;
  status: string;
  taskDays: number | null;
  classNextDay?: boolean;
  /** Lo explicado hoy en clase: la señal más fuerte del bloque de avance. */
  seenToday?: boolean;
}

/**
 * Prioridad del día. El orden del enunciado: examen próximo → tema débil →
 * repaso vencido → avance nuevo → práctica de errores. Se traduce a números
 * acotados para que ninguna señal aplaste a las demás.
 */
export function scoreCandidate(input: ScoreInput): number {
  let score = 0;

  // Examen próximo (y cuánto pondera).
  if (input.daysToExam !== null) {
    const days = Math.max(1, input.daysToExam);
    const urgency = Math.max(0, 30 / days);
    score += Math.min(60, urgency * 12) * (1 + (input.examWeight > 0 ? 0.3 : 0));
  }

  // Tema débil: solo si el nivel está MEDIDO (sin medir no es flojera, es duda).
  if (input.measured) {
    score += ((100 - clampNumber(input.mastery, 0, 100, 50)) / 100) * 40;
  } else {
    score += 12; // primera pasada: construye la base
  }

  // Repaso vencido: manda antes que «avanzar» si el examen está cerca.
  if (input.dueReview) {
    score += 20 + Math.min(18, input.overdueDays * 4);
    if (input.retention !== null) score += (100 - input.retention) * 0.2;
    if (input.daysToExam !== null && input.daysToExam <= 10) score += 10;
  }

  // Errores abiertos: práctica concreta, no teoría otra vez.
  score += Math.min(24, input.errorsOpen * 8);

  // Avance nuevo: lo que se está dando en clase ahora vale más que lo viejo.
  if (input.status === 'en_curso') score += 18;
  else if (input.status === 'visto') score += 6;
  else if (input.status === 'pendiente') score += 4;

  // Entrega de Moodle: una fecha de entrega es un examen pequeño.
  if (input.taskDays !== null && input.taskDays <= 14) {
    score += Math.min(20, (7 / Math.max(1, input.taskDays)) * 10);
  }

  // Lo explicado HOY en clase manda sobre cualquier otro avance. Es la señal más
  // fuerte del bloque (por encima de los +18 de `en_curso`): la explicación del
  // profesor todavía está fresca y la sesión de la tarde sirve para fijarla, no
  // para aprenderla de cero. Ninguna otra novedad del temario la adelanta.
  if (input.seenToday) score += 55;

  // Materia que se da mañana: la tarde anterior es el momento en que mejor se
  // fija (llega a clase con la explicación ya masticada). Pesa menos que un
  // examen próximo o un repaso vencido, y más que «avanzar por avanzar».
  if (input.classNextDay) score += 16;

  // Dificultad: a igualdad de lo demás, primero lo que cuesta.
  score += clampNumber(input.difficulty, 1, 5, 3) * 2;

  return Math.round(score * 10) / 10;
}

/** Una sesión tal como se guarda y se pinta en «Hoy toca esto». */
export interface DayPlanSessionView {
  id: string;
  topicId: string;
  topicTitle: string;
  unitNumber: number | null;
  subjectId: string;
  subjectName: string;
  subjectColor: string;
  durationMinutes: number;
  breakMinutes: number;
  stage: SessionStage;
  technique: string;
  objective: string;
  reason: string;
  material: string;
  status: string;
  origin: string;
  isCompleted: boolean;
  spentMinutes: number;
  orderIndex: number;
  mastery: number;
  masterySource: string;
}

export interface PlannedSession {
  candidate: PlanCandidate;
  durationMinutes: number;
  breakMinutes: number;
  bucket: SessionBucket;
  stage: SessionStage;
  technique: StudyTechnique;
  objective: string;
  reason: string;
  material: string;
  orderIndex: number;
}

export interface PlanSessionsOptions {
  /** Modo de estudio: manda en el techo de sesiones del día. */
  mode?: 'comfort' | 'athlete';
  energy?: EnergyLevel;
  /** Por qué días sin estudiar toca un plan de recuperación. */
  recovery?: boolean;
  /** Techo manual de sesiones (lo usa el plan de recuperación). */
  maxSessions?: number;
}

const STAGE_ORDER: SessionStage[] = ['simulacro', 'correccion', 'repaso', 'comprension', 'practica'];

/**
 * Elige la duración de una sesión que quepa en `availableMinutes` y no pase de
 * lo que hace falta (`need`). Prefiere el bloque más largo que quepa: 40 minutos
 * disponibles para un tema nuevo no se convierten en dos de 15.
 */
export function chooseDuration(
  availableMinutes: number,
  need: number,
  energy: EnergyLevel = 'media'
): number | null {
  if (availableMinutes < MIN_SESSION_MINUTES) return null;

  const wanted = Math.max(need, MIN_SESSION_MINUTES);
  // No se propone una sesión que triplique lo que hace falta: para 10 minutos de
  // trabajo, un bloque de 90 no es ambición, es relleno.
  const ceiling = wanted <= MIN_SESSION_MINUTES ? 25 : wanted * 1.6;

  const allowed = SESSION_LENGTHS.filter((minutes) => {
    if (minutes > availableMinutes) return false;
    if (minutes > ceiling) return false;
    if (minutes >= 60 && energy === 'baja') return false;
    return true;
  });

  if (allowed.length === 0) {
    // Nada «ideal» cabe: se ofrece lo mejor que quepa sin pasarse del tiempo.
    const fallback = SESSION_LENGTHS.filter((minutes) => minutes <= availableMinutes);
    return fallback.length > 0 ? fallback[0] : MIN_SESSION_MINUTES;
  }

  return allowed[allowed.length - 1];
}

interface WorkingCandidate {
  candidate: PlanCandidate;
  left: Record<SessionStage, number>;
  sessions: number;
  usedStages: SessionStage[];
}

/**
 * Reparte el tiempo disponible en sesiones que encajan, sin pasarse nunca.
 *
 * Reglas que se respetan aquí y se comprueban en `verify:sesiones`:
 *   - La suma de duraciones ≤ `availableMinutes` (siempre).
 *   - Ninguna sesión por debajo de 10 minutos.
 *   - Se alternan materias antes de repetir en la misma.
 *   - Las fases se vacían de la más urgente a la menos: simulacro, corrección,
 *     repaso, comprensión y práctica.
 *   - Si quedan menos de 10 minutos, se para: no se ofrece una sesión imposible.
 */
export function planSessions(
  candidates: PlanCandidate[],
  availableMinutes: number,
  options: PlanSessionsOptions = {}
): PlannedSession[] {
  const mode = options.mode ?? 'athlete';
  const energy = options.energy ?? 'media';
  const maxSessions =
    options.maxSessions ?? (options.recovery || mode === 'comfort' ? 2 : mode === 'athlete' ? 4 : 3);

  const working: WorkingCandidate[] = candidates
    .map((candidate) => ({
      candidate,
      left: {
        comprension: candidate.work.comprension,
        practica: candidate.work.practica,
        repaso: candidate.work.repaso,
        correccion: candidate.work.correccion,
        simulacro: candidate.work.simulacro,
      },
      sessions: 0,
      usedStages: [],
    }))
    .filter((item) => totalLeft(item.left) >= MIN_SESSION_MINUTES);

  const plan: PlannedSession[] = [];
  let remaining = Math.max(0, Math.floor(availableMinutes));
  const usedToday = new Set<string>();

  while (remaining >= MIN_SESSION_MINUTES && plan.length < maxSessions) {
    // Candidato: el de más prioridad que aún tenga trabajo. Si hay alternativas
    // de materias sin usar hoy, se prefiere no repetir materia.
    const withWork = working.filter((item) => totalLeft(item.left) >= MIN_SESSION_MINUTES);
    if (withWork.length === 0) break;

    const fresh = withWork.filter((item) => !usedToday.has(item.candidate.subjectId));
    const pool = fresh.length > 0 ? fresh : withWork;
    pool.sort((a, b) => b.candidate.priority - a.candidate.priority);

    const item = pool[0];
    const stage = nextStage(item.left);
    if (!stage) break;

    const need = item.left[stage];
    const duration = chooseDuration(remaining, need, energy);
    if (!duration) break;

    item.left[stage] = Math.max(0, need - duration);
    item.sessions += 1;
    item.usedStages.push(stage);
    usedToday.add(item.candidate.subjectId);

    plan.push({
      candidate: item.candidate,
      durationMinutes: duration,
      breakMinutes: breakForMinutes(duration),
      bucket: bucketForMinutes(duration),
      stage,
      technique: SESSION_STAGES[stage].technique,
      objective: buildObjective(item.candidate, stage, duration),
      reason: buildReason(item.candidate, stage),
      material: buildMaterial(item.candidate, stage),
      orderIndex: plan.length + 1,
    });

    remaining -= duration;
  }

  return plan;
}

function totalLeft(left: Record<SessionStage, number>): number {
  return STAGE_ORDER.reduce((acc, stage) => acc + Math.max(0, left[stage] ?? 0), 0);
}

/** La fase más urgente que aún tiene trabajo. */
function nextStage(left: Record<SessionStage, number>): SessionStage | null {
  for (const stage of STAGE_ORDER) {
    if ((left[stage] ?? 0) >= MIN_SESSION_MINUTES) return stage;
  }
  // Restos pequeños (5-9 min) de una fase: se suman a la más grande que quede.
  let best: SessionStage | null = null;
  let bestLeft = 0;
  for (const stage of STAGE_ORDER) {
    const value = left[stage] ?? 0;
    if (value > bestLeft) {
      best = stage;
      bestLeft = value;
    }
  }
  return bestLeft >= MIN_SESSION_MINUTES ? best : null;
}

/**
 * Título corto para el objetivo: hay temarios que traen tres unidades pegadas
 * con «·» y una sesión de 25 minutos no puede titularse con 200 caracteres.
 */
function shortTitle(title: string): string {
  const clean = String(title ?? '').split(' · ')[0].trim();
  return clean.length > 80 ? `${clean.slice(0, 77).trimEnd()}…` : clean;
}

function buildObjective(candidate: PlanCandidate, stage: SessionStage, minutes: number): string {
  const unit = shortTitle(candidate.topicTitle);
  switch (stage) {
    case 'comprension':
      return `Entender ${unit} y ser capaz de explicarlo sin mirar (${minutes} min)`;
    case 'practica':
      return `Resolver ejercicios de ${unit} del tipo que cae en el examen (${minutes} min)`;
    case 'repaso':
      return `Recuperar de memoria ${unit} antes de que se enfríe (${minutes} min)`;
    case 'correccion':
      return `Cerrar ${candidate.errorsOpen} error(es) de ${unit} sin volver a repetirlos (${minutes} min)`;
    case 'simulacro':
      return `Simulacro cronometrado de ${unit} en condiciones reales (${minutes} min)`;
  }
}

/**
 * Una frase con el motivo. Es la parte del enunciado que pedía «muéstrame
 * siempre por qué toca esa sesión hoy»: sin esto, la agenda es una imposición.
 */
function buildReason(candidate: PlanCandidate, stage: SessionStage): string {
  if (candidate.daysToExam === 0) {
    return `El examen${candidate.examTitle ? ` de ${candidate.examTitle}` : ''} es hoy.`;
  }

  if (stage === 'simulacro' && candidate.daysToExam !== null) {
    return `Quedan ${candidate.daysToExam} día(s) para el examen${candidate.examTitle ? ` de ${candidate.examTitle}` : ''}: toca probarlo cronometrado.`;
  }

  if (stage === 'correccion' && candidate.errorsOpen > 0) {
    return `Tienes ${candidate.errorsOpen} error(es) abiertos aquí y son los que más nota cuestan.`;
  }

  if (candidate.seenToday) {
    return 'Lo has dado hoy en clase: repasarlo esta tarde, con la explicación todavía fresca, es cuando de verdad se fija.';
  }

  if (candidate.classNextDay) {
    return `Mañana tienes ${candidate.subjectName} en clase: prepararlo la tarde anterior es cuando mejor se fija.`;
  }

  if (stage === 'repaso') {
    if (candidate.dueReview) {
      const late = candidate.overdueDays > 0 ? ` (${candidate.overdueDays} día(s) de retraso)` : '';
      const pct = candidate.retention !== null ? ` y solo recuerdas un ${candidate.retention}%` : '';
      return `El repaso está vencido${late}${pct}: se olvida si no se recupera hoy.`;
    }
    return candidate.retention !== null
      ? `Retención estimada del ${candidate.retention}%: se acerca el punto de olvido.`
      : 'Ya lo has trabajado: toca consolidarlo.';
  }

  if (candidate.daysToExam !== null && candidate.daysToExam <= 10) {
    return `Examen en ${candidate.daysToExam} día(s)${candidate.examWeight > 0 ? ' y pondera para la PAU' : ''}.`;
  }

  if (candidate.status === 'en_curso') {
    return 'Es lo que estás dando en clase ahora: lo freso se aprovecha mejor.';
  }

  if (candidate.measured && candidate.mastery < 50) {
    return `Es tu unidad más floja medida (${candidate.mastery}%).`;
  }

  if (!candidate.measured) {
    return 'Todavía no hay nivel medido aquí: esta es la primera pasada.';
  }

  if (candidate.taskDays !== null) {
    return `Hay una entrega de ${candidate.subjectName} en ${candidate.taskDays} día(s).`;
  }

  if (candidate.examWeight > 0) {
    return 'Pondera para la PAU y aún no está consolidado.';
  }

  return 'Avanza el temario sin dejar atrás lo anterior.';
}

function buildMaterial(candidate: PlanCandidate, stage: SessionStage): string {
  switch (stage) {
    case 'comprension':
      return 'Apuntes y libro del tema; una hoja en blanco para esquematizar de memoria';
    case 'practica':
      return 'Enunciados tipo PAU y cuaderno de trabajo';
    case 'repaso':
      return 'Preguntas de recuperación sin mirar los apuntes (y el banco de errores)';
    case 'correccion':
      return 'Banco de errores: enunciado, tu respuesta y la solución oficial';
    case 'simulacro':
      return 'Examen completo, cronómetro y sin consultar nada';
  }
}

/* ------------------------------------------------------------------ */
/* 5. Microtareas, recuperación y reprogramación                        */
/* ------------------------------------------------------------------ */

export interface MicroTask {
  minutes: number;
  label: string;
  reason: string;
}

/**
 * «Si termino antes de tiempo, dame algo útil de 5 minutos.» Nunca trabajo
 * nuevo: cinco preguntas, cinco tarjetas o el último error.
 */
export function microTasks(input: {
  topicTitle?: string | null;
  errorsOpen?: number;
  dueReviews?: number;
}): MicroTask[] {
  const tasks: MicroTask[] = [
    {
      minutes: 5,
      label: '5 preguntas de recuperación del tema de hoy',
      reason: 'El esfuerzo de recordar es lo que fija la memoria (no releer)',
    },
    {
      minutes: 5,
      label: '5 flashcards de las que peor llevas',
      reason: 'Consolidación rápida sin abrir tema nuevo',
    },
  ];

  if ((input.errorsOpen ?? 0) > 0) {
    tasks.push({
      minutes: 7,
      label: 'Repasar el último error del banco',
      reason: 'Un error repetido cuesta más nota que un tema nuevo',
    });
  }

  if ((input.dueReviews ?? 0) > 0) {
    tasks.push({
      minutes: 10,
      label: `Repasar ${Math.min(3, input.dueReviews ?? 0)} unidad(es) vencida(s)`,
      reason: 'Están a punto de olvidarse: 10 minutos ahora ahorran media hora luego',
    });
  }

  return tasks.sort((a, b) => a.minutes - b.minutes);
}

export interface RecoveryPlan {
  active: boolean;
  daysWithoutStudy: number | null;
  maxSessions: number;
  headline: string;
  detail: string;
}

/**
 * «Si llevo varios días sin estudiar, un plan de recuperación realista.» No se
 * recupera lo perdido de golpe: se vuelve a arrancar sin montar una deuda.
 */
export function recoveryPlan(daysWithoutStudy: number | null): RecoveryPlan {
  const days = daysWithoutStudy;

  if (days === null) {
    return {
      active: false,
      daysWithoutStudy: null,
      maxSessions: 4,
      headline: 'Primer día',
      detail: 'Todavía no hay historial: se empieza por lo que toca hoy.',
    };
  }

  if (days >= 7) {
    return {
      active: true,
      daysWithoutStudy: days,
      maxSessions: 1,
      headline: `Vuelta tras ${days} días`,
      detail:
        'Plan de recuperación: una sola sesión corta de lo más urgente. Recuperar la semana entera de golpe no funciona; volver a la rutina, sí.',
    };
  }

  if (days >= 3) {
    return {
      active: true,
      daysWithoutStudy: days,
      maxSessions: 2,
      headline: `Vuelta tras ${days} días`,
      detail:
        'Plan de recuperación: dos sesiones cortas (lo vencido y lo que viene). Se recupera el ritmo antes que el temario.',
    };
  }

  return {
    active: false,
    daysWithoutStudy: days,
    maxSessions: 4,
    headline: 'Ritmo normal',
    detail: 'Vienes estudiando estos días: el plan es el normal.',
  };
}

/**
 * Qué hacer con una sesión que no se completó: vuelve al siguiente hueco real,
 * con lo que faltaba, no entera otra vez. Si se abandonó varias veces, baja de
 * prioridad en vez de acumularse.
 */
export function rescheduleSession(input: {
  durationMinutes: number;
  spentMinutes: number;
  abandonCount?: number;
}): { minutesLeft: number; keep: boolean; note: string } {
  const spent = Math.max(0, input.spentMinutes);
  const left = Math.max(0, input.durationMinutes - spent);
  const abandons = Math.max(0, input.abandonCount ?? 0);

  if (left < MIN_SESSION_MINUTES) {
    return { minutesLeft: 0, keep: false, note: 'Quedaba tan poco que se da por cerrada.' };
  }

  if (abandons >= 3) {
    return {
      minutesLeft: left,
      keep: false,
      note: 'Se ha abandonado tres veces: deja de reprogramarse y vuelve por prioridad, no por deuda.',
    };
  }

  return {
    minutesLeft: left,
    keep: true,
    note: `Vuelve al siguiente hueco con los ${left} min que faltaban (no se repite lo ya hecho).`,
  };
}

/* ------------------------------------------------------------------ */
/* 6. Repaso adaptativo (FSRS simplificado)                             */
/* ------------------------------------------------------------------ */

/**
 * El objetivo por defecto: llegar al examen recordando. No se repasa todo cada
 * día; se repasa lo que está cerca de olvidarse (o lo crítico para el examen).
 */
export const TARGET_RETENTION = 0.9;

/** Parámetros de la curva FSRS: con t = S, la probabilidad de recuerdo es 90%. */
export const FSRS_DECAY = -0.5;
export const FSRS_FACTOR = 19 / 81;

/**
 * Pesos del modelo, los de FSRS-5. Están aquí a la vista porque son estimaciones
 * poblacionales: lo que de verdad te pasa a ti se mide con tus repasos.
 */
const W = [0.4, 0.6, 2.4, 5.8, 4.93, 0.94, 0.86, 0.01, 1.49, 0.14, 0.94, 2.18, 0.05, 0.34, 1.26, 0.29, 2.61];

export type FsrsRating = 'again' | 'hard' | 'good' | 'easy';

const RATING_INDEX: Record<FsrsRating, number> = { again: 0, hard: 1, good: 2, easy: 3 };

export interface FsrsState {
  /** Días para los que el recuerdo cae al 90%. */
  stability: number;
  /** 1 (fácil) a 10 (muy difícil). */
  difficulty: number;
  lastReviewedAt: Date | null;
}

export interface FsrsNext {
  stability: number;
  difficulty: number;
  /** Probabilidad de recuerdo en el momento del repaso (0-1). */
  retrievabilityAtReview: number;
  /** Días hasta el próximo repaso para el objetivo pedido. */
  intervalDays: number;
  nextReviewAt: Date;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + Math.round(days));
  return copy;
}

/**
 * Probabilidad de recordar hoy, dada la estabilidad y los días pasados.
 * `R = (1 + F·t/S)^D`, con D = -0.5 y F = 19/81 → R(S, S) = 0.9.
 */
export function retrievability(stability: number, elapsedDays: number): number {
  const s = Math.max(0.01, Number(stability) || 0.01);
  const t = Math.max(0, Number(elapsedDays) || 0);
  const value = Math.pow(1 + FSRS_FACTOR * (t / s), FSRS_DECAY);
  return clamp(value, 0, 1);
}

/**
 * Días hasta que la probabilidad caiga al objetivo (0.9 por defecto).
 * Despejando de la curva: `t = S/F · (R^(1/D) - 1)`.
 */
export function intervalForRetention(stability: number, retention: number = TARGET_RETENTION): number {
  const s = Math.max(0.01, Number(stability) || 0.01);
  const r = clamp(Number(retention) || TARGET_RETENTION, 0.5, 0.99);
  const t = (s / FSRS_FACTOR) * (Math.pow(r, 1 / FSRS_DECAY) - 1);
  return Math.max(1, Math.round(t));
}

export function initFsrsState(rating: FsrsRating, difficultyBase: number = 5): FsrsState {
  const index = RATING_INDEX[rating];
  const stability = Math.max(0.1, W[index]);
  const difficulty = clamp(
    W[4] - Math.exp(W[5] * (index - 3)) + 1 + (clamp(difficultyBase, 1, 10) - 5) * 0.15,
    1,
    10
  );
  return { stability, difficulty, lastReviewedAt: null };
}

/**
 * Aplica un repaso y devuelve la memoria nueva. `again` reinicia (lo has
 * olvidado), `good` estira, `easy` estira más y `hard` menos.
 */
export function scheduleFsrs(
  state: FsrsState,
  rating: FsrsRating,
  now: Date = new Date(),
  retention: number = TARGET_RETENTION
): FsrsNext {
  const index = RATING_INDEX[rating];
  const stability = Math.max(0.05, state.stability || W[index]);
  const difficulty = clamp(state.difficulty || 5, 1, 10);

  const elapsed = state.lastReviewedAt
    ? Math.max(0, (startOfDay(now).getTime() - startOfDay(state.lastReviewedAt).getTime()) / 86400000)
    : 0;
  const r = state.lastReviewedAt ? retrievability(stability, elapsed) : 0.9;

  // Dificultad: sube si fallas, baja si te sobra (amortiguada con la inicial).
  const d0 = clamp(W[4] - Math.exp(W[5] * (index - 3)) + 1, 1, 10);
  const nextDifficulty = clamp(
    W[7] * d0 + (1 - W[7]) * (difficulty - W[6] * (index - 3)),
    1,
    10
  );

  let nextStability: number;
  if (index === 0) {
    // Fallo: vuelve a estabilidad baja, pero no a cero (algo queda).
    nextStability = W[11] * Math.pow(difficulty, -W[12]) * (Math.pow(stability + 1, W[13]) - 1) * Math.exp((1 - r) * W[14]);
  } else {
    const hardPenalty = index === 1 ? W[15] : 1;
    const easyBonus = index === 3 ? W[16] : 1;
    nextStability =
      stability *
      (1 +
        Math.exp(W[8]) *
          (11 - difficulty) *
          Math.pow(stability, -W[9]) *
          (Math.exp((1 - r) * W[10]) - 1) *
          hardPenalty *
          easyBonus);
  }

  nextStability = clamp(nextStability, 0.1, 36500);
  const intervalDays = index === 0 ? 1 : intervalForRetention(nextStability, retention);

  return {
    stability: Math.round(nextStability * 100) / 100,
    difficulty: Math.round(nextDifficulty * 100) / 100,
    retrievabilityAtReview: Math.round(r * 1000) / 1000,
    intervalDays,
    nextReviewAt: startOfDay(addDays(now, intervalDays)),
  };
}

/**
 * Probabilidad de recordar el día del examen. Es el dato que decide qué repasar
 * primero cuando la fecha está cerca: no lo más vencido, lo más probable de
 * fallar ese día.
 */
export function recallAtExam(
  state: { stability: number; lastReviewedAt: Date | null },
  examDate: Date,
  now: Date = new Date()
): number | null {
  if (!state.lastReviewedAt) return null;
  const daysToExam = Math.max(
    0,
    Math.round((startOfDay(examDate).getTime() - startOfDay(now).getTime()) / 86400000)
  );
  const elapsed = Math.max(
    0,
    (startOfDay(now).getTime() - startOfDay(state.lastReviewedAt).getTime()) / 86400000
  );
  return Math.round(retrievability(state.stability, elapsed + daysToExam) * 100);
}

/** ¿Hay que repasarlo hoy para llegar al examen con el objetivo de recuerdo? */
export function needsReviewBeforeExam(input: {
  stability: number;
  lastReviewedAt: Date | null;
  examDate: Date | null;
  now?: Date;
  target?: number;
}): boolean {
  const now = input.now ?? new Date();
  const target = input.target ?? TARGET_RETENTION;
  if (!input.lastReviewedAt) return false;
  if (!input.examDate) return false;

  const examRecall = recallAtExam(
    { stability: input.stability, lastReviewedAt: input.lastReviewedAt },
    input.examDate,
    now
  );
  if (examRecall === null) return false;
  if (examRecall / 100 >= target) return false;

  // Solo si el repaso todavía puede hacer algo: la víspera del examen, repasar
  // algo que no has visto nunca no es un plan.
  const daysToExam = Math.round(
    (startOfDay(input.examDate).getTime() - startOfDay(now).getTime()) / 86400000
  );
  return daysToExam >= 0;
}
