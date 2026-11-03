/**
 * Retos semanales.
 *
 * Un reto no es una insignia decorativa: es la semana dicha en corto. Aquí se
 * generan **a partir de lo que de verdad le falta al alumno** —los repasos que se
 * le han vencido, los errores que aún no ha cerrado, el examen que tiene encima,
 * las horas que dijo que podía estudiar— y se evalúan contra el trabajo hecho,
 * no contra una casilla que se marca a mano.
 *
 * Tres reglas que se respetan siempre:
 *
 *   - **Pocos y posibles.** Cuatro retos como máximo, y ninguno que pida más de
 *     lo que ya se ha demostrado capaz de hacer: si la semana pasada cerró dos de
 *     cuatro, esta semana la meta baja, no sube.
 *   - **Derivados, no inventados.** Cada reto sale de un dato real (unidades
 *     vencidas, errores abiertos, exámenes fechados). Si no hay datos, hay menos
 *     retos, no retos de relleno.
 *   - **Medibles solos.** El progreso se cuenta de la base (repasos, minutos,
 *     errores cerrados), así que nadie tiene que acordarse de marcar nada.
 *
 * Módulo puro (sin Prisma ni red) para poder probarlo de forma aislada.
 */

export type ChallengeUnit = 'count' | 'minutes' | 'percent' | 'days';

export type ChallengeKind =
  | 'srs_reviews'
  | 'study_minutes'
  | 'master_errors'
  | 'simulacro'
  | 'mastery_gain'
  | 'streak_days';

export const CHALLENGE_KINDS: Record<
  ChallengeKind,
  { label: string; unit: ChallengeUnit; description: string; badgeColor: string }
> = {
  srs_reviews: {
    label: 'Repasos vencidos',
    unit: 'count',
    description: 'Cierra repasos del calendario para que las unidades no se enfríen',
    badgeColor: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30',
  },
  study_minutes: {
    label: 'Horas de estudio',
    unit: 'minutes',
    description: 'Cumple las horas que tú mismo te has puesto',
    badgeColor: 'bg-blue-500/10 text-blue-400 border-blue-500/30',
  },
  master_errors: {
    label: 'Errores cerrados',
    unit: 'count',
    description: 'Tacha errores del banco hasta que no vuelvan a costarte puntos',
    badgeColor: 'bg-rose-500/10 text-rose-400 border-rose-500/30',
  },
  simulacro: {
    label: 'Simulacro PAU',
    unit: 'count',
    description: 'Un examen cronometrado de verdad antes del de verdad',
    badgeColor: 'bg-purple-500/10 text-purple-400 border-purple-500/30',
  },
  mastery_gain: {
    label: 'Subida de nivel',
    unit: 'percent',
    description: 'Sube el nivel medido de una materia que va floja',
    badgeColor: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  },
  streak_days: {
    label: 'Racha de días',
    unit: 'days',
    description: 'Días seguidos tocando una unidad: la constancia manda',
    badgeColor: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
  },
};

export type ChallengeStatus = 'active' | 'completed' | 'expired';

export const CHALLENGE_STATUS_META: Record<
  ChallengeStatus,
  { label: string; badgeColor: string }
> = {
  active: { label: 'En juego', badgeColor: 'bg-sky-500/10 text-sky-400 border-sky-500/30' },
  completed: {
    label: 'Conseguido',
    badgeColor: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  },
  expired: { label: 'Se quedó a medias', badgeColor: 'bg-slate-500/10 text-slate-400 border-slate-500/30' },
};

export function isChallengeKind(value: unknown): value is ChallengeKind {
  return typeof value === 'string' && value in CHALLENGE_KINDS;
}

export function isChallengeStatus(value: unknown): value is ChallengeStatus {
  return value === 'active' || value === 'completed' || value === 'expired';
}

/* ------------------------------------------------------------------ */
/* 1. La semana (ISO, de lunes a domingo)                               */
/* ------------------------------------------------------------------ */

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

/** Lunes a las 00:00 de la semana a la que pertenece la fecha. */
export function weekStartOf(date: Date): Date {
  const day = startOfDay(date);
  const weekday = (day.getDay() + 6) % 7; // 0 = lunes
  return startOfDay(addDays(day, -weekday));
}

/** Domingo a las 23:59 de esa semana. */
export function weekEndOf(date: Date): Date {
  return addDays(weekStartOf(date), 7);
}

/**
 * Clave de semana ISO-8601 («2026-W42»). Se usa la numeración ISO y no el número
 * de semana del año porque es la única que no parte las semanas entre dos años.
 */
export function weekKeyOf(date: Date): string {
  const day = startOfDay(date);
  // Jueves de la semana: el año ISO es el del jueves.
  const thursday = addDays(day, 3 - ((day.getDay() + 6) % 7));
  const isoYear = thursday.getFullYear();

  const jan1 = new Date(isoYear, 0, 1);
  const firstThursday = addDays(jan1, 3 - ((jan1.getDay() + 6) % 7));
  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 86400000));

  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

export function isSameWeek(a: Date, b: Date): boolean {
  return weekKeyOf(a) === weekKeyOf(b);
}

/** «6 de octubre» — etiqueta legible del lunes o del domingo de la semana. */
export function weekRangeLabel(weekStart: Date): string {
  const start = startOfDay(weekStart);
  const end = addDays(start, 6);
  const fmt = (date: Date) =>
    date.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
  return `${fmt(start)} – ${fmt(end)}`;
}

/* ------------------------------------------------------------------ */
/* 2. Generación: los retos que le hacen falta esta semana              */
/* ------------------------------------------------------------------ */

export interface ChallengeSeed {
  kind: ChallengeKind;
  title: string;
  description: string;
  target: number;
  unit: ChallengeUnit;
  subjectId: string | null;
  subjectName: string | null;
  topicId: string | null;
  topicTitle: string | null;
  rewardXp: number;
}

export interface MeasuredTopicRef {
  id: string;
  title: string;
  unitNumber: number | null;
  masteryLevel: number;
  subjectId: string;
  subjectName: string;
}

export interface WeeklyChallengeInput {
  /** Nombres y colores de las materias (para retos con materia). */
  subjects: Array<{ id: string; name: string }>;
  /** Unidades con nivel medido, de la más floja a la menos. */
  measuredTopics: MeasuredTopicRef[];
  /** Repasos SRS vencidos o de hoy. */
  dueReviews: number;
  /** Errores del banco sin cerrar. */
  pendingErrors: number;
  /** Errores cerrados la semana pasada (para calibrar la meta). */
  errorsClosedLastWeek: number;
  /** Exámenes próximos, ordenados por cercanía. */
  upcomingExams: Array<{ subjectId: string; subjectName: string; title: string; days: number }>;
  /** Horas semanales que el alumno declaró. */
  weeklyHoursCap: number;
  /** ¿Las declaró él o es el valor de partida? */
  weeklyHoursDeclared: boolean;
  streakCurrent: number;
  /** Cómo fue la semana pasada: sirve para bajar la meta si se quedó corto. */
  lastWeek: { total: number; completed: number; minutes: number; reviews: number } | null;
}

/** Tope de retos vivos por semana: más de cuatro no se miran. */
export const MAX_WEEKLY_CHALLENGES = 4;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** XP que vale un reto según lo que pide: los largos pagan más, con techo. */
export function xpForTarget(unit: ChallengeUnit, target: number): number {
  const perUnit: Record<ChallengeUnit, number> = {
    count: 8,
    minutes: 3,
    percent: 12,
    days: 20,
  };
  return clamp(Math.round(30 + target * perUnit[unit]), 40, 220);
}

/**
 * Genera los retos de la semana. El orden de la lista es el orden de prioridad:
 * primero los repasos que se están enfriando, luego los errores que cuestan
 * puntos, después la materia más floja, y el simulacro solo si hay examen cerca.
 */
export function buildWeeklyChallengeSeeds(input: WeeklyChallengeInput): ChallengeSeed[] {
  const seeds: ChallengeSeed[] = [];

  // Cómo le fue la semana pasada: si cerró poco, la meta de esta semana es más
  // asequible. Empezar pidiendo más de lo que ya falló es la forma de que nadie
  // mire los retos dos semanas.
  const struggled = input.lastWeek !== null && input.lastWeek.total > 0 && input.lastWeek.completed <= input.lastWeek.total / 2;

  /* 1. Repasos vencidos: el reto por defecto, porque es el que evita el olvido. */
  if (input.dueReviews > 0) {
    const target = clamp(Math.round(input.dueReviews * (struggled ? 1.2 : 1.6)), 4, 40);
    seeds.push({
      kind: 'srs_reviews',
      title: `Cierra ${target} repasos`,
      description:
        input.dueReviews > target
          ? `Tienes ${input.dueReviews} repasos vencidos o de hoy. Empieza por los que peor recuerdes.`
          : 'Tienes repasos vencidos o de hoy. Déjalos a cero.',
      target,
      unit: 'count',
      subjectId: null,
      subjectName: null,
      topicId: null,
      topicTitle: null,
      rewardXp: xpForTarget('count', target),
    });
  }

  /* 2. Errores del banco: cerrar lo que ya te ha costado puntos. */
  if (input.pendingErrors > 0) {
    const target = clamp(
      Math.round(
        input.errorsClosedLastWeek > 0 && !struggled
          ? input.errorsClosedLastWeek * 1.25
          : input.pendingErrors * 0.5
      ),
      3,
      15
    );
    seeds.push({
      kind: 'master_errors',
      title: `Cierra ${target} errores`,
      description: `Tienes ${input.pendingErrors} errores sin cerrar. Los que repites son los que te bajan la nota.`,
      target,
      unit: 'count',
      subjectId: null,
      subjectName: null,
      topicId: null,
      topicTitle: null,
      rewardXp: xpForTarget('count', target),
    });
  }

  /* 3. La materia más floja: subir su nivel medido, un reto, no un deseo. */
  const weakest = input.measuredTopics.find((topic) => topic.masteryLevel < 70);
  if (weakest) {
    const target = clamp(struggled ? 5 : 8, 4, 12);
    seeds.push({
      kind: 'mastery_gain',
      title: `Sube ${target} puntos en ${weakest.subjectName}`,
      description: `«${weakest.title}»${weakest.unitNumber ? ` (U${weakest.unitNumber})` : ''} está en ${weakest.masteryLevel}%. Con medirlo en serio ya sube.`,
      target,
      unit: 'percent',
      subjectId: weakest.subjectId,
      subjectName: weakest.subjectName,
      topicId: weakest.id,
      topicTitle: weakest.title,
      rewardXp: xpForTarget('percent', target),
    });
  }

  /* 4. Simulacro: solo con un examen a la vista. Sin examen no se simula. */
  const nextExam = input.upcomingExams[0];
  if (nextExam && nextExam.days <= 21) {
    const target = nextExam.days <= 10 ? 2 : 1;
    seeds.push({
      kind: 'simulacro',
      title: `Haz ${target === 1 ? 'un simulacro' : `${target} simulacros`} de ${nextExam.subjectName}`,
      description: `${nextExam.title} en ${nextExam.days} días. Enfrentarse antes es la mitad del examen.`,
      target,
      unit: 'count',
      subjectId: nextExam.subjectId,
      subjectName: nextExam.subjectName,
      topicId: null,
      topicTitle: null,
      rewardXp: xpForTarget('count', target),
    });
  }

  /* 5. Horas: las que él dijo que podía, con un 80% de margen. */
  const declaredHours = clamp(input.weeklyHoursCap, 4, 60);
  const minutesTarget = clamp(
    Math.round((declaredHours * 60 * (struggled ? 0.6 : 0.8)) / 30) * 30,
    150,
    1800
  );
  seeds.push({
    kind: 'study_minutes',
    title: `Estudia ${(minutesTarget / 60).toFixed(minutesTarget % 60 === 0 ? 0 : 1)} h esta semana`,
    description: input.weeklyHoursDeclared
      ? 'Son tus horas, no las mías. Solo cuentan las sesiones que registres en Modo Enfoque.'
      : 'Es una meta de partida: declara tus horas reales en Ajustes y la ajusto.',
    target: minutesTarget,
    unit: 'minutes',
    subjectId: null,
    subjectName: null,
    topicId: null,
    topicTitle: null,
    rewardXp: xpForTarget('minutes', minutesTarget),
  });

  /* 6. Racha: mantener el ritmo pesa más de lo que parece. */
  if (input.streakCurrent >= 2) {
    const target = clamp(input.streakCurrent + 2, 4, 7);
    seeds.push({
      kind: 'streak_days',
      title: `Mantén ${target} días seguidos`,
      description: `Vas por ${input.streakCurrent}. Dos días más y la semana cuenta doble.`,
      target,
      unit: 'days',
      subjectId: null,
      subjectName: null,
      topicId: null,
      topicTitle: null,
      rewardXp: xpForTarget('days', target),
    });
  }

  return seeds.slice(0, MAX_WEEKLY_CHALLENGES);
}

/* ------------------------------------------------------------------ */
/* 3. Evaluación: cuánto llevas de cada reto                            */
/* ------------------------------------------------------------------ */

/** Progreso (0-100 %) de un reto, con el mínimo y el techo respetados. */
export function challengePercent(target: number, current: number): number {
  if (!Number.isFinite(target) || target <= 0) return 0;
  return clamp(Math.round((current / target) * 100), 0, 100);
}

export function isChallengeMet(target: number, current: number): boolean {
  return Number.isFinite(target) && target > 0 && current >= target;
}

export interface ChallengeProgressView {
  current: number;
  target: number;
  percent: number;
  met: boolean;
  /** «12/20 repasos», «340/600 min», «+3 de +8 puntos»… */
  label: string;
}

function formatAmount(unit: ChallengeUnit, value: number): string {
  if (unit === 'minutes') {
    const hours = value / 60;
    return `${hours.toFixed(hours >= 10 || Number.isInteger(hours) ? 0 : 1)} h`;
  }
  if (unit === 'percent') return `${value > 0 ? '+' : ''}${Math.round(value)} pts`;
  if (unit === 'days') return `${Math.round(value)} d`;
  return `${Math.round(value)}`;
}

/** Vista de progreso lista para pintar (texto incluido, para no repetirlo en cada sitio). */
export function describeProgress(
  target: number,
  unit: string,
  current: number
): ChallengeProgressView {
  const safeUnit: ChallengeUnit = (['count', 'minutes', 'percent', 'days'] as const).includes(
    unit as ChallengeUnit
  )
    ? (unit as ChallengeUnit)
    : 'count';

  return {
    current,
    target,
    percent: challengePercent(target, current),
    met: isChallengeMet(target, current),
    label: `${formatAmount(safeUnit, current)} / ${formatAmount(safeUnit, target)}`,
  };
}

/* ------------------------------------------------------------------ */
/* 3-bis. Medición: de los datos de la semana al progreso del reto       */
/* ------------------------------------------------------------------ */

/**
 * Todo el trabajo hecho en la semana, ya agregado. Quien lo construye consulta la
 * base (una vez por semana, no una vez por reto) y el resto es aritmética pura:
 * así el progreso de un reto se puede probar sin levantar nada.
 */
export interface WeekWorkData {
  /** Repasos SRS de la semana. */
  reviews: Array<{ topicId: string; subjectId: string | null }>;
  /**
   * Sesiones de estudio de la semana, con los minutos y los puntos de nivel
   * ganados en cada una (`masteryDelta`, nunca negativo).
   */
  sessions: Array<{ topicId: string; subjectId: string; minutes: number; masteryDelta: number }>;
  /** Errores cerrados en la semana. */
  closedErrors: Array<{ subjectId: string }>;
  /** Simulacros PAU terminados en la semana. */
  simulacros: Array<{ subjectId: string | null; subjectName: string }>;
  /**
   * Días (a medianoche) con al menos una sesión de estudio, sin repetir. No se
   * limita a la semana: la racha es una métrica continua y hay que mirar hacia
   * atrás para saber cuántos días seguidos llevas de verdad.
   */
  studyDays: Date[];
}

/** Reto con su alcance: global, de una materia o de una unidad concreta. */
export interface ChallengeScope {
  subjectId: string | null;
  topicId: string | null;
}

/** Entradas de la racha: días de estudio consecutivos que terminan hoy o ayer. */
export function currentStudyStreak(studyDays: Date[], now: Date = new Date()): number {
  const keys = new Set(studyDays.map((day) => startOfDay(day).toISOString().slice(0, 10)));
  if (keys.size === 0) return 0;

  const today = startOfDay(now);
  // Si hoy todavía no ha estudiado, la racha se cuenta desde ayer: aún está viva.
  const anchor = keys.has(today.toISOString().slice(0, 10)) ? today : addDays(today, -1);

  let streak = 0;
  let cursor = anchor;
  while (keys.has(cursor.toISOString().slice(0, 10))) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

/**
 * Cuánto lleva hecho un reto esta semana. El alcance filtra: un reto de
 * Matemáticas solo cuenta lo de Matemáticas, y uno de la U4 solo la U4.
 */
export function challengeProgress(
  kind: ChallengeKind,
  scope: ChallengeScope,
  data: WeekWorkData,
  now: Date = new Date()
): number {
  const inSubject = (subjectId: string | null) =>
    !scope.subjectId || subjectId === scope.subjectId;
  const inScope = (row: { topicId?: string; subjectId: string | null }) =>
    inSubject(row.subjectId) && (!scope.topicId || row.topicId === scope.topicId);

  switch (kind) {
    case 'srs_reviews':
      return data.reviews.filter((row) => inScope(row)).length;

    case 'study_minutes':
      return data.sessions
        .filter((row) => inScope(row))
        .reduce((acc, row) => acc + Math.max(0, row.minutes), 0);

    case 'master_errors':
      return data.closedErrors.filter((row) => inSubject(row.subjectId)).length;

    case 'simulacro':
      return data.simulacros.filter((row) =>
        scope.subjectId ? row.subjectId === scope.subjectId : true
      ).length;

    case 'mastery_gain':
      return Math.round(
        data.sessions
          .filter((row) => inScope(row))
          .reduce((acc, row) => acc + Math.max(0, row.masteryDelta), 0)
      );

    case 'streak_days':
      return currentStudyStreak(data.studyDays, now);

    default:
      return 0;
  }
}

/** Semáforo del reto, para que el color diga lo mismo que el número. */
export function challengeProgressTone(percent: number, met: boolean): { label: string; className: string } {
  if (met) return { label: 'Conseguido', className: 'text-emerald-400' };
  if (percent >= 70) return { label: 'Casi', className: 'text-sky-400' };
  if (percent >= 35) return { label: 'A medio camino', className: 'text-amber-400' };
  if (percent > 0) return { label: 'Arrancando', className: 'text-slate-400' };
  return { label: 'Sin empezar', className: 'text-slate-500' };
}

/* ------------------------------------------------------------------ */
/* 4. Experiencia y nivel (el nivel se deriva, no se guarda)             */
/* ------------------------------------------------------------------ */

export const LEVEL_TITLES = [
  'Recluta',
  'Cadete',
  'Cabo',
  'Sargento',
  'Alférez',
  'Teniente',
  'Capitán',
  'Comandante',
  'Coronel',
  'General',
];

/** XP que hace falta para subir del nivel `level` al siguiente. */
export function xpForLevel(level: number): number {
  return 120 + (level - 1) * 80;
}

export interface LevelInfo {
  level: number;
  title: string;
  totalXp: number;
  /** XP dentro del nivel actual. */
  xpInLevel: number;
  /** XP que pide el nivel actual completo. */
  xpForNext: number;
  percent: number;
}

/**
 * Nivel a partir de la XP acumulada. Se calcula, no se guarda: así la XP que
 * entra por un reto conseguido no puede quedar desincronizada del nivel.
 */
export function levelFromXp(totalXp: number): LevelInfo {
  const xp = Math.max(0, Math.floor(Number.isFinite(totalXp) ? totalXp : 0));
  let level = 1;
  let remaining = xp;
  let need = xpForLevel(1);

  while (remaining >= need && level < 99) {
    remaining -= need;
    level += 1;
    need = xpForLevel(level);
  }

  return {
    level,
    title: LEVEL_TITLES[Math.min(LEVEL_TITLES.length - 1, level - 1)],
    totalXp: xp,
    xpInLevel: remaining,
    xpForNext: need,
    percent: clamp(Math.round((remaining / need) * 100), 0, 100),
  };
}
