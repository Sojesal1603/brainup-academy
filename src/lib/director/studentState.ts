/**
 * Estado compartido del alumno y política determinista del director.
 *
 * Este módulo es puro: no importa Prisma, Next, IA ni lee el reloj. Recibe la
 * foto que el planificador ya calculó y devuelve:
 *
 *   · un `StudentState` versionado (materias, unidades medidas, errores,
 *     exámenes, disponibilidad, adherencia y energía);
 *   · las desviaciones detectadas con reglas explícitas;
 *   · una decisión (`hold`, `replan`, `reduce`…) con su explicación.
 *
 * El objetivo es que los agentes no se hablen entre sí: leen el mismo estado y
 * aplican la misma política. La IA solo puede narrar después esta decisión.
 */

export type DirectorEnergy = 'alta' | 'media' | 'baja';

export type DirectorDecision =
  | 'hold'
  | 'replan'
  | 'reduce'
  | 'prioritize_exam'
  | 'recover';

export type DirectorDeviationCode =
  | 'atraso'
  | 'examen'
  | 'sobrecarga'
  | 'sin_plan'
  | 'repasos'
  | 'errores'
  | 'racha';

export type DirectorSeverity = 'alta' | 'media' | 'baja';

export interface DirectorDeviation {
  code: DirectorDeviationCode;
  severity: DirectorSeverity;
  title: string;
  detail: string;
}

export interface StudentStateUnit {
  id: string;
  title: string;
  subjectId: string;
  subjectName: string;
  subjectColor: string;
  mastery: number;
  measured: boolean;
  status: string;
  errorsOpen: number;
  daysToExam: number | null;
  examTitle: string | null;
}

export interface StudentStateSession {
  id: string;
  subjectId: string;
  topicTitle: string;
  durationMinutes: number;
  isCompleted: boolean;
  status: string;
}

export interface StudentStateSubject {
  id: string;
  name: string;
  color: string;
  totalUnits: number;
  measuredUnits: number;
  errorsOpen: number;
  nextExamTitle: string | null;
  daysToExam: number | null;
}

export interface StudentStateExam {
  subjectName: string;
  title: string;
  days: number;
}

export interface StudentStateAdherence {
  plannedBlocks: number;
  completedBlocks: number;
  completedMinutes: number;
  plannedMinutes: number;
  ratio: number;
  rescheduledBlocks: number;
  pausedBlocks: number;
  staleBlocks: number;
}

export interface StudentState {
  version: string;
  generatedAtIso: string;
  dayKey: string;
  timezone: string;
  energy: DirectorEnergy;
  energyChosen: boolean;
  availability: {
    availableMinutes: number;
    plannedMinutes: number;
    completedMinutes: number;
    studiedMinutes: number;
  };
  subjects: StudentStateSubject[];
  exams: StudentStateExam[];
  units: {
    total: number;
    measured: number;
  };
  errorsOpen: number;
  dueReviews: number;
  streak: {
    current: number;
    studiedToday: boolean;
  };
  adherence: StudentStateAdherence;
  deviations: DirectorDeviation[];
  decision: DirectorDecision;
  summary: string;
}

export interface BuildStudentStateInput {
  now: Date;
  dayKey: string;
  timezone: string;
  energy: DirectorEnergy;
  energyChosen: boolean;
  availableMinutes: number;
  plannedMinutes: number;
  completedMinutes: number;
  studiedMinutes: number;
  dueReviews: number;
  errorsOpen: number;
  streakCurrent: number;
  studiedToday: boolean;
  rescheduledBlocks: number;
  pausedBlocks: number;
  staleBlocks: number;
  units: readonly StudentStateUnit[];
  sessions: readonly StudentStateSession[];
}

export interface DirectorPlanSignal {
  /** `active`, `invalidated`, `draft` o null si aún no hay fila. */
  planStatus: string | null;
  /** Bloques vivos de hoy (incluidos completados). */
  liveBlocks: number;
  /** Bloques de días anteriores sin cerrar. */
  staleBlocks: number;
}

export type DirectorReplanReason = 'plan_invalidado' | 'sin_bloques' | 'atraso';

/**
 * Decide si hay que reconstruir el plan. Es la misma política que usa
 * `ensureTodayPlan` dentro del advisory lock: si no devuelve un motivo, no se
 * escribe nada y la apertura es de solo lectura.
 */
export function directorReplanReason(signal: DirectorPlanSignal): DirectorReplanReason | null {
  if (signal.planStatus === 'invalidated') return 'plan_invalidado';
  if (signal.staleBlocks > 0) return 'atraso';
  if (signal.liveBlocks === 0) return 'sin_bloques';
  return null;
}

export function shouldRegeneratePlan(signal: DirectorPlanSignal): boolean {
  return directorReplanReason(signal) !== null;
}

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function hash(value: string): string {
  // FNV-1a de 32 bits: suficiente para versionar una foto y comparar en tests.
  let h = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    h ^= value.charCodeAt(index);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function severityRank(severity: DirectorSeverity): number {
  return severity === 'alta' ? 0 : severity === 'media' ? 1 : 2;
}

function subjectStats(units: readonly StudentStateUnit[]): StudentStateSubject[] {
  const map = new Map<string, StudentStateSubject>();
  for (const unit of units) {
    const current = map.get(unit.subjectId) ?? {
      id: unit.subjectId,
      name: unit.subjectName,
      color: unit.subjectColor,
      totalUnits: 0,
      measuredUnits: 0,
      errorsOpen: 0,
      nextExamTitle: null,
      daysToExam: null,
    };
    current.totalUnits += 1;
    if (unit.measured) current.measuredUnits += 1;
    current.errorsOpen += nonNegative(unit.errorsOpen);
    if (
      unit.daysToExam !== null &&
      (current.daysToExam === null || unit.daysToExam < current.daysToExam)
    ) {
      current.daysToExam = unit.daysToExam;
      current.nextExamTitle = unit.examTitle;
    }
    map.set(unit.subjectId, current);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function examsOf(units: readonly StudentStateUnit[]): StudentStateExam[] {
  const map = new Map<string, StudentStateExam>();
  for (const unit of units) {
    if (unit.daysToExam === null || !unit.examTitle) continue;
    const key = `${unit.subjectName}|${unit.examTitle}`;
    const current = map.get(key);
    if (!current || unit.daysToExam < current.days) {
      map.set(key, {
        subjectName: unit.subjectName,
        title: unit.examTitle,
        days: unit.daysToExam,
      });
    }
  }
  return [...map.values()].sort(
    (a, b) => a.days - b.days || a.subjectName.localeCompare(b.subjectName) || a.title.localeCompare(b.title)
  );
}

function deviationsOf(state: Omit<StudentState, 'deviations' | 'decision' | 'summary' | 'version'>): DirectorDeviation[] {
  const deviations: DirectorDeviation[] = [];
  const nextExam = state.exams[0];

  if (state.adherence.staleBlocks > 0) {
    deviations.push({
      code: 'atraso',
      severity: 'alta',
      title: 'Bloques de días anteriores sin cerrar',
      detail: `${state.adherence.staleBlocks} bloque(s) siguen pendientes; el director los devuelve a hoy solo si caben.`,
    });
  } else if (state.adherence.rescheduledBlocks > 0) {
    deviations.push({
      code: 'atraso',
      severity: 'media',
      title: 'Trabajo reprogramado',
      detail: `${state.adherence.rescheduledBlocks} bloque(s) vienen de ayer y se han colocado delante.`,
    });
  }

  if (nextExam && nextExam.days <= 3) {
    deviations.push({
      code: 'examen',
      severity: 'alta',
      title: `Examen de ${nextExam.subjectName} ${nextExam.days <= 0 ? 'hoy' : nextExam.days === 1 ? 'mañana' : `en ${nextExam.days} días`}`,
      detail: `«${nextExam.title}»: el plan prioriza lo que más rinde antes de esa fecha.`,
    });
  }

  if (state.availability.plannedMinutes > state.availability.availableMinutes + 10) {
    deviations.push({
      code: 'sobrecarga',
      severity: 'alta',
      title: 'El plan no cabe en la ventana real',
      detail: `${state.availability.plannedMinutes} min planificados frente a ${state.availability.availableMinutes} disponibles.`,
    });
  }

  if (
    state.availability.plannedMinutes === 0 &&
    state.availability.availableMinutes >= 10 &&
    state.units.total > 0
  ) {
    deviations.push({
      code: 'sin_plan',
      severity: 'media',
      title: 'Hay ventana pero no hay sesiones',
      detail: 'El director puede repartir el tiempo disponible sin inventar trabajo.',
    });
  }

  if (state.dueReviews > 0) {
    deviations.push({
      code: 'repasos',
      severity: state.dueReviews >= 10 ? 'alta' : 'media',
      title: `${state.dueReviews} repaso(s) vencidos`,
      detail: 'Entran antes que el contenido nuevo: recuperarlos hoy cuesta menos.',
    });
  }

  if (state.errorsOpen > 0) {
    deviations.push({
      code: 'errores',
      severity: state.errorsOpen >= 5 ? 'media' : 'baja',
      title: `${state.errorsOpen} error(es) sin corregir`,
      detail: 'El banco de errores alimenta las sesiones de corrección.',
    });
  }

  if (state.streak.current >= 3 && !state.streak.studiedToday && state.adherence.plannedBlocks > 0) {
    deviations.push({
      code: 'racha',
      severity: 'baja',
      title: `Racha de ${state.streak.current} días en riesgo`,
      detail: 'Todavía no hay minutos estudiados hoy; el primer bloque mantiene el hábito.',
    });
  }

  return deviations.sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity) || a.code.localeCompare(b.code)
  );
}

function decide(deviations: DirectorDeviation[]): DirectorDecision {
  if (deviations.some((deviation) => deviation.code === 'sobrecarga')) return 'reduce';
  if (deviations.some((deviation) => deviation.code === 'atraso' || deviation.code === 'sin_plan')) {
    return 'replan';
  }
  if (deviations.some((deviation) => deviation.code === 'examen')) return 'prioritize_exam';
  if (deviations.some((deviation) => deviation.code === 'repasos' || deviation.code === 'errores')) {
    return 'recover';
  }
  return 'hold';
}

function summaryOf(
  decision: DirectorDecision,
  state: Omit<StudentState, 'deviations' | 'decision' | 'summary' | 'version'>,
  deviations: DirectorDeviation[]
): string {
  const nextExam = state.exams[0];
  const examText = nextExam
    ? ` Examen de ${nextExam.subjectName} ${nextExam.days <= 0 ? 'hoy' : nextExam.days === 1 ? 'mañana' : `en ${nextExam.days} días`}.`
    : '';

  if (decision === 'reduce') {
    return `El director reduce el alcance: el plan no cabe en la ventana de hoy.${examText}`;
  }
  if (decision === 'replan') {
    return `El director reajusta la agenda con lo atrasado y lo que de verdad cabe hoy.${examText}`;
  }
  if (decision === 'prioritize_exam') {
    return `El director mantiene la ruta y adelanta la materia del examen.${examText}`;
  }
  if (decision === 'recover') {
    return `El director mantiene la ruta y coloca primero repasos y errores abiertos.${examText}`;
  }

  const risk = deviations[0];
  if (risk) {
    return `El director mantiene el plan: ${risk.title.toLowerCase()}.${examText}`;
  }
  return `El director mantiene el plan: ${state.adherence.plannedBlocks} bloque(s) y ${state.availability.plannedMinutes} min.${examText}`;
}

/**
 * Construye el estado versionado. La versión se calcula con los datos estables
 * (sin la hora de generación), así que dos lecturas del mismo estado dan el
 * mismo hash aunque cambie el reloj.
 */
export function buildStudentState(input: BuildStudentStateInput): StudentState {
  const units = [...input.units].sort(
    (a, b) => a.subjectId.localeCompare(b.subjectId) || a.id.localeCompare(b.id)
  );
  const sessions = [...input.sessions].sort(
    (a, b) =>
      a.subjectId.localeCompare(b.subjectId) ||
      a.topicTitle.localeCompare(b.topicTitle) ||
      a.durationMinutes - b.durationMinutes ||
      a.id.localeCompare(b.id)
  );
  const subjects = subjectStats(units);
  const exams = examsOf(units);
  const plannedBlocks = sessions.length;
  const completedBlocks = sessions.filter((session) => session.isCompleted).length;
  const measured = units.filter((unit) => unit.measured).length;
  const availableMinutes = nonNegative(input.availableMinutes);
  const plannedMinutes = nonNegative(input.plannedMinutes);
  const completedMinutes = nonNegative(input.completedMinutes);

  const base = {
    generatedAtIso: input.now.toISOString(),
    dayKey: input.dayKey,
    timezone: input.timezone,
    energy: input.energy,
    energyChosen: input.energyChosen,
    availability: {
      availableMinutes,
      plannedMinutes,
      completedMinutes,
      studiedMinutes: nonNegative(input.studiedMinutes),
    },
    subjects,
    exams,
    units: {
      total: units.length,
      measured,
    },
    errorsOpen: nonNegative(input.errorsOpen),
    dueReviews: nonNegative(input.dueReviews),
    streak: {
      current: nonNegative(input.streakCurrent),
      studiedToday: input.studiedToday,
    },
    adherence: {
      plannedBlocks,
      completedBlocks,
      completedMinutes,
      plannedMinutes,
      ratio: plannedBlocks === 0 ? 0 : completedBlocks / plannedBlocks,
      rescheduledBlocks: nonNegative(input.rescheduledBlocks),
      pausedBlocks: nonNegative(input.pausedBlocks),
      staleBlocks: nonNegative(input.staleBlocks),
    },
  };

  const deviations = deviationsOf(base);
  const decision = decide(deviations);
  const summary = summaryOf(decision, base, deviations);

  // El hash excluye la hora de generación y el resumen: solo cambia cuando
  // cambia un dato que puede alterar la decisión.
  const versionSource = {
    dayKey: base.dayKey,
    timezone: base.timezone,
    energy: base.energy,
    energyChosen: base.energyChosen,
    availability: base.availability,
    subjects,
    exams,
    units: base.units,
    errorsOpen: base.errorsOpen,
    dueReviews: base.dueReviews,
    streak: base.streak,
    adherence: base.adherence,
    decision,
    deviations: deviations.map((deviation) => deviation.code),
    sessions,
  };
  return {
    ...base,
    version: `director-v1-${hash(JSON.stringify(versionSource))}`,
    deviations,
    decision,
    summary,
  };
}

/** Datos que puede usar la narración; nunca decide ni inventa bloques. */
export function buildDirectorNarrationFacts(state: StudentState): string[] {
  const facts = [
    `Decisión: ${state.decision}.`,
    `Disponibilidad: ${state.availability.availableMinutes} min; plan: ${state.availability.plannedMinutes} min en ${state.adherence.plannedBlocks} bloque(s).`,
    `Adherencia: ${state.adherence.completedBlocks}/${state.adherence.plannedBlocks} bloques cerrados.`,
    `Unidades medidas: ${state.units.measured}/${state.units.total}. Errores abiertos: ${state.errorsOpen}. Repasos vencidos: ${state.dueReviews}.`,
    `Energía: ${state.energy}${state.energyChosen ? ' (elegida por el alumno)' : ' (por la hora)'}.`,
  ];
  if (state.exams[0]) {
    const exam = state.exams[0];
    facts.push(
      `Próximo examen: ${exam.title} de ${exam.subjectName}, ${exam.days <= 0 ? 'hoy' : exam.days === 1 ? 'mañana' : `en ${exam.days} días`}.`
    );
  }
  for (const deviation of state.deviations.slice(0, 3)) {
    facts.push(`${deviation.title}: ${deviation.detail}`);
  }
  return facts;
}
