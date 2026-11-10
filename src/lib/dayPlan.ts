import { prisma } from './prisma';
import { updateDefaultProfile } from './userProfile';
import { effectiveMastery } from './knowledge';
import { estimateRetention, isDue, overdueDays, startOfDay } from './srs';
import { dueReviewCardsByTopic } from './reviewCards';
import {
  calibrationByTechnique,
  calibrationFor,
  energyForMoment,
  estimateTopicWork,
  microTasks,
  planSessions,
  recallAtExam,
  recoveryPlan,
  rescheduleSession,
  retrievability,
  scoreCandidate,
  type CalibrationSample,
  type DayPlanSessionView,
  type EnergyLevel,
  type MicroTask,
  type PlanCandidate,
  type RecoveryPlan,
  type SessionStage,
} from './sessionEngine';
import type { StudyMode } from './types';

/**
 * El plan del día: todo lo que hace falta para que al abrir la app solo haya que
 * pulsar «Empezar».
 *
 * Junta el horario real, los exámenes, el nivel medido, los errores abiertos, el
 * repaso vencido y el tiempo que de verdad queda hoy, y lo convierte en sesiones
 * concretas (con su objetivo, su motivo y su descanso) guardadas en
 * `StudyBlock`. La pantalla no calcula nada: lee lo que el motor ya decidió, y
 * por eso el Cuartel, el planificador y el Modo Enfoque no pueden discrepar.
 */

const DAY_MS = 86400000;
/** Hora a la que se cierra el estudio entre semana (minutos desde medianoche). */
const WEEKDAY_END = 22 * 60 + 30;
/** Descanso de comida y vuelta a casa tras la última clase. */
const AFTER_SCHOOL_GAP = 45;
/** Si no hay horario ese día, la tarde empieza aquí. */
const NO_TIMETABLE_START = 17 * 60;
/** Fin de semana: dos ventanas (mañana y tarde). */
const WEEKEND_WINDOWS: Array<[number, number]> = [
  [10 * 60, 14 * 60],
  [16 * 60 + 30, 22 * 60 + 30],
];

function minutesOf(hhmm: string | null | undefined): number {
  const raw = String(hhmm ?? '');
  const [h, m] = raw.split(':').map((part) => Number(part));
  if (!Number.isFinite(h)) return 0;
  return h * 60 + (Number.isFinite(m) ? m : 0);
}

function labelOf(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function dayRange(day: Date): { start: Date; end: Date } {
  const start = startOfDay(day);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

function daysBetween(from: Date, to: Date): number {
  return Math.round((startOfDay(to).getTime() - startOfDay(from).getTime()) / DAY_MS);
}

/**
 * Índice del próximo día lectivo (1 = lunes ... 5 = viernes).
 *
 * La tarde se planifica pensando en las clases de MAÑANA: lo que se explica en
 * el aula al día siguiente rinde mucho más si se ha mirado la tarde antes.
 */
function nextSchoolDayIndex(date: Date): number {
  const day = date.getDay();
  for (let offset = 1; offset <= 7; offset++) {
    const candidate = (day + offset) % 7;
    if (candidate >= 1 && candidate <= 5) return candidate;
  }
  return 1;
}

function hoursLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/* ------------------------------------------------------------------ */
/* 1. Tiempo real disponible                                            */
/* ------------------------------------------------------------------ */

export interface AvailabilityPeriod {
  startTime: string;
  endTime: string;
}

export interface DayAvailability {
  availableMinutes: number;
  /** «16:05 → 22:30» o «10:00–14:00 · 16:30–22:30». */
  windowLabel: string;
  /** Por qué quedan esos minutos, para poder enseñarlo. */
  reason: string;
  classMinutes: number;
  studiedMinutes: number;
  /** Techo de horas del perfil, repartido por día. */
  dailyCapMinutes: number;
  energy: EnergyLevel;
  isWeekend: boolean;
}

/**
 * Calcula el tiempo disponible de un día.
 *
 * No usa una cifra fija: mira cuánto duran las clases de ese día, suma la comida
 * y la vuelta a casa, cierra a las 22:30, reparte tus horas semanales declaradas
 * por seis días (uno de descanso) y **descuenta lo que ya has estudiado hoy**.
 * Si el resultado es cero, es cero: el plan no va a inventarse tiempo.
 */
export function computeAvailability(input: {
  day: Date;
  now: Date;
  periods: AvailabilityPeriod[];
  weeklyHoursCap: number;
  studiedMinutes: number;
}): DayAvailability {
  const day = startOfDay(input.day);
  const now = input.now;
  const isToday = day.getTime() === startOfDay(now).getTime();
  const weekday = day.getDay();
  const isWeekend = weekday === 0 || weekday === 6;

  const nowMinutes = isToday ? now.getHours() * 60 + now.getMinutes() : 0;

  const periods = [...input.periods].sort((a, b) => a.startTime.localeCompare(b.startTime));
  const classMinutes = isWeekend
    ? 0
    : periods.reduce((acc, period) => acc + Math.max(0, minutesOf(period.endTime) - minutesOf(period.startTime)), 0);

  let windows: Array<[number, number]> = [];
  if (isWeekend) {
    windows = WEEKEND_WINDOWS.map(([a, b]) => [a, b] as [number, number]);
  } else if (periods.length > 0) {
    const lastEnd = periods.reduce((acc, period) => Math.max(acc, minutesOf(period.endTime)), 0);
    windows = [[lastEnd + AFTER_SCHOOL_GAP, WEEKDAY_END]];
  } else {
    windows = [[NO_TIMETABLE_START, WEEKDAY_END]];
  }

  let rawMinutes = 0;
  const labels: string[] = [];
  for (const [start, end] of windows) {
    const effectiveStart = Math.max(start, nowMinutes);
    const minutes = Math.max(0, end - effectiveStart);
    rawMinutes += minutes;
    if (minutes > 0) labels.push(`${labelOf(effectiveStart)} → ${labelOf(end)}`);
  }

  // Tus horas declaradas mandan: si dijiste 15 h/semana, un día no puede tener 8.
  const dailyCapMinutes = Math.max(
    0,
    Math.round(((Number(input.weeklyHoursCap) || 0) * 60) / 6 / 5) * 5
  );
  const studiedMinutes = Math.max(0, Math.round(input.studiedMinutes));

  let availableMinutes = Math.floor(rawMinutes / 5) * 5;
  if (dailyCapMinutes > 0) availableMinutes = Math.min(availableMinutes, dailyCapMinutes);
  availableMinutes = Math.max(0, availableMinutes - studiedMinutes);

  const reason =
    availableMinutes <= 0
      ? rawMinutes <= 0
        ? 'Ya no queda ventana de estudio hoy: el plan se queda en lo hecho.'
        : 'Tu tope de horas semanales ya está cubierto hoy.'
      : `${labels.join(' · ')}${classMinutes > 0 ? ` · ${hoursLabel(classMinutes)} de clase` : ''}${
          studiedMinutes > 0 ? ` · ${hoursLabel(studiedMinutes)} ya estudiados` : ''
        }`;

  return {
    availableMinutes: Math.max(0, Math.floor(availableMinutes / 5) * 5),
    windowLabel: labels.length > 0 ? labels.join(' · ') : 'sin ventana',
    reason,
    classMinutes,
    studiedMinutes,
    dailyCapMinutes,
    energy: energyForMoment(isToday ? now : new Date(day.getTime() + 12 * 3600000), isWeekend),
    isWeekend,
  };
}

/* ------------------------------------------------------------------ */
/* 2. Candidatos: qué puede entrar hoy                                  */
/* ------------------------------------------------------------------ */

interface PlanningContext {
  now: Date;
  weeklyHoursCap: number;
  mode: StudyMode;
  calibration: Record<string, number>;
  candidates: PlanCandidate[];
  periodByDay: Map<number, AvailabilityPeriod[]>;
  studiedMinutesToday: number;
  daysSinceStudy: number | null;
  dueReviews: number;
  errorsOpen: number;
  hasTemario: boolean;
}

async function loadPlanningContext(now: Date): Promise<PlanningContext> {
  const todayStart = startOfDay(now);

  const [user, subjects, periods, tasks, todaySessions, recentBlocks, lastSession] = await Promise.all([
    prisma.userProfile.findUnique({ where: { id: 'user_default' } }),
    prisma.subject.findMany({
      where: { isTracked: true },
      orderBy: [{ order: 'asc' }, { name: 'asc' }],
      include: {
        topics: { include: { errors: { where: { isMastered: false } } } },
        exams: { where: { isCompleted: false, examDate: { gte: todayStart } }, orderBy: { examDate: 'asc' } },
      },
    }),
    prisma.classPeriod.findMany({
      select: { dayOfWeek: true, subjectId: true, startTime: true, endTime: true },
    }),
    prisma.moodleTask.findMany({
      where: { isCompleted: false, dueDate: { gte: todayStart }, subjectId: { not: null } },
      orderBy: { dueDate: 'asc' },
      select: { subjectId: true, dueDate: true },
    }),
    prisma.studySession.findMany({
      where: { startedAt: { gte: todayStart } },
      select: { minutesSpent: true },
    }),
    prisma.studyBlock.findMany({
      where: {
        date: { gte: new Date(todayStart.getTime() - 60 * DAY_MS) },
        spentMinutes: { gt: 0 },
      },
      select: { technique: true, durationMinutes: true, spentMinutes: true },
    }),
    prisma.studySession.findFirst({ orderBy: { startedAt: 'desc' }, select: { startedAt: true } }),
  ]);

  const periodByDay = new Map<number, AvailabilityPeriod[]>();
  // Horas de clase por semana y materia: es lo que ya se ha explicado en el aula.
  const weeklyClassMinutes = new Map<string, number>();
  // Qué materias se dan cada día: con esto se prepara la clase de mañana.
  const subjectsByDay = new Map<number, Set<string>>();
  for (const period of periods) {
    if (!periodByDay.has(period.dayOfWeek)) periodByDay.set(period.dayOfWeek, []);
    periodByDay.get(period.dayOfWeek)!.push({ startTime: period.startTime, endTime: period.endTime });
    if (!subjectsByDay.has(period.dayOfWeek)) subjectsByDay.set(period.dayOfWeek, new Set());
    subjectsByDay.get(period.dayOfWeek)!.add(period.subjectId);
    weeklyClassMinutes.set(
      period.subjectId,
      (weeklyClassMinutes.get(period.subjectId) ?? 0) +
        Math.max(0, minutesOf(period.endTime) - minutesOf(period.startTime))
    );
  }

  const nextDaySubjects = subjectsByDay.get(nextSchoolDayIndex(now)) ?? new Set<string>();

  const nextTaskBySubject = new Map<string, Date>();
  for (const task of tasks) {
    if (task.subjectId && !nextTaskBySubject.has(task.subjectId)) {
      nextTaskBySubject.set(task.subjectId, task.dueDate);
    }
  }

  const samples: CalibrationSample[] = recentBlocks.map((block) => ({
    technique: block.technique,
    plannedMinutes: block.durationMinutes,
    spentMinutes: block.spentMinutes,
  }));
  const calibration = calibrationByTechnique(samples);

  const candidates: PlanCandidate[] = [];
  let dueReviews = 0;
  let errorsOpenTotal = 0;

  for (const subject of subjects) {
    const nextExam = subject.exams[0] ?? null;
    const examDate = nextExam ? new Date(nextExam.examDate) : null;
    const daysToExam = examDate ? daysBetween(now, examDate) : null;
    const taskDate = nextTaskBySubject.get(subject.id) ?? null;
    const taskDays = taskDate ? daysBetween(now, taskDate) : null;
    const weeklyMinutes = weeklyClassMinutes.get(subject.id) ?? 0;
    // ¿Tiene clase mañana? Se prepara hoy, que es cuando sirve.
    const classNextDay = nextDaySubjects.has(subject.id);

    for (const topic of subject.topics) {
      const measured = topic.masterySource !== 'sin_medir';
      const mastery = effectiveMastery(topic);
      const errorsOpen = topic.errors.length;
      const due = isDue(topic, now);
      const overdue = overdueDays(topic, now);
      // ¿Se ha explicado HOY en clase? Es la señal más fuerte del avance: la
      // explicación del profesor sigue fresca y la sesión de la tarde es para
      // fijarla. Se compara por día local, no por las últimas 24 horas.
      const seenToday = Boolean(
        topic.seenInClassAt &&
          startOfDay(topic.seenInClassAt).getTime() === startOfDay(now).getTime()
      );

      // Retención: FSRS si hay memoria medida; si no, la curva del intervalo
      // clásico. Nunca se inventa un porcentaje si no hay ningún repaso.
      const stability = topic.srsStability ?? null;
      const retention =
        stability !== null && topic.lastReviewedAt
          ? Math.round(
              retrievability(
                stability,
                Math.max(
                  0,
                  (startOfDay(now).getTime() - startOfDay(topic.lastReviewedAt).getTime()) / DAY_MS
                )
              ) * 100
            )
          : estimateRetention(topic, now);

      const retentionAtExam =
        stability !== null && examDate
          ? recallAtExam({ stability, lastReviewedAt: topic.lastReviewedAt }, examDate, now)
          : null;

      // Estimación del trabajo que queda, por fases. Los minutos de clase que
      // se le suponen a una unidad salen de repartir las horas semanales de esa
      // materia (una unidad se explica en unas tres semanas).
      const classMinutesPerUnit = weeklyMinutes > 0 ? Math.round((weeklyMinutes * 3) / 2) : 0;

      const work = estimateTopicWork({
        difficulty: topic.difficulty,
        mastery,
        measured,
        errorsOpen,
        daysToExam,
        examWeight: subject.pauWeight,
        targetGrade: subject.targetGrade,
        minutesAlready: Math.round(topic.completedHours * 60),
        calibration: calibrationFor(calibration, topic.status === 'pendiente' ? 'active_recall' : 'problemas'),
        signals: { classMinutes: classMinutesPerUnit },
      });

      const priority = scoreCandidate({
        daysToExam,
        examWeight: subject.pauWeight,
        measured,
        mastery,
        errorsOpen,
        difficulty: topic.difficulty,
        dueReview: due,
        overdueDays: overdue,
        retention,
        status: topic.status,
        taskDays,
        classNextDay,
        seenToday,
      });

      if (due) dueReviews += 1;
      errorsOpenTotal += errorsOpen;

      candidates.push({
        topicId: topic.id,
        topicTitle: topic.title,
        subjectId: subject.id,
        subjectName: subject.name,
        subjectColor: subject.color,
        priority,
        work,
        difficulty: topic.difficulty,
        mastery,
        measured,
        daysToExam,
        examWeight: subject.pauWeight,
        examTitle: nextExam?.title ?? null,
        dueReview: due,
        overdueDays: overdue,
        retention,
        retentionAtExam,
        errorsOpen,
        status: topic.status,
        seen: topic.status !== 'pendiente',
        taskDays,
        classNextDay,
        seenToday,
      });
    }
  }

  candidates.sort((a, b) => b.priority - a.priority);

  const studiedMinutesToday = todaySessions.reduce((acc, session) => acc + session.minutesSpent, 0);

  const lastDay = lastSession ? startOfDay(lastSession.startedAt) : null;
  const daysSinceStudy = lastDay ? daysBetween(lastDay, now) : null;

  return {
    now,
    weeklyHoursCap: user?.weeklyHoursCap ?? 20,
    mode: ((user?.studyMode as StudyMode) ?? 'athlete') as StudyMode,
    calibration,
    candidates,
    periodByDay,
    studiedMinutesToday,
    daysSinceStudy,
    dueReviews,
    errorsOpen: errorsOpenTotal,
    hasTemario: candidates.length > 0,
  };
}

/* ------------------------------------------------------------------ */
/* 3. Generar y guardar el plan                                         */
/* ------------------------------------------------------------------ */

export interface PersistDayResult {
  created: number;
  plannedMinutes: number;
  availableMinutes: number;
  skipped: boolean;
  reason: string | null;
  /** Temas que se quedaron a medias y vuelven al plan de hoy. */
  carried: number;
  /** Bloques antiguos que ya no caben y se cierran como abandonados. */
  abandoned: number;
}

/**
 * Genera y guarda las sesiones de UN día.
 *
 * Antes de crear nada se mira lo que quedó pendiente de días anteriores: lo que
 * falta vuelve al hueco de hoy **solo si cabe**, y lo que ya no cabe se marca
 * como abandonado en vez de acumularse en una lista infinita. Un «pendiente» de
 * hace nueve días no es trabajo, es culpa.
 */
export async function persistDayPlan(
  options: {
    day?: Date;
    now?: Date;
    force?: boolean;
    /** Techo declarado por el alumno para hoy (se cruza con el tiempo real). */
    budgetMinutes?: number;
  } = {}
): Promise<PersistDayResult> {
  const now = options.now ?? new Date();
  const day = startOfDay(options.day ?? now);
  const isToday = day.getTime() === startOfDay(now).getTime();
  const ctx = await loadPlanningContext(now);

  if (!ctx.hasTemario) {
    return {
      created: 0,
      plannedMinutes: 0,
      availableMinutes: 0,
      skipped: true,
      reason: 'Sin temario no hay nada que planificar: carga tus unidades o haz la puesta a punto.',
      carried: 0,
      abandoned: 0,
    };
  }

  const { start, end } = dayRange(day);
  const periods = ctx.periodByDay.get(day.getDay()) ?? [];

  // El avance real de hoy: lo que ya está cerrado y lo que está a medias. Se
  // descuenta del presupuesto para que el plan nuevo no vuelva a ofrecer un
  // hueco que ya se ha gastado (ni repita una sesión empezada).
  const todayDone = isToday
    ? await prisma.studyBlock.aggregate({
        where: { date: { gte: start, lt: end }, isCompleted: true },
        _sum: { spentMinutes: true },
      })
    : null;
  const todayReserved: Array<{ durationMinutes: number; spentMinutes: number }> = isToday
    ? await prisma.studyBlock.findMany({
        where: {
          date: { gte: start, lt: end },
          isCompleted: false,
          status: { in: ['parcial', 'en_curso'] },
        },
        select: { durationMinutes: true, spentMinutes: true },
      })
    : [];

  const reservedMinutes = todayReserved.reduce(
    (total, block) => total + Math.max(0, block.durationMinutes - block.spentMinutes),
    0
  );
  // Se coge el mayor de las dos fuentes para no contar dos veces la misma
  // sesión (el Modo Enfoque apunta la sesión y el bloque a la vez).
  const studiedForBudget = Math.max(
    ctx.studiedMinutesToday,
    todayDone?._sum.spentMinutes ?? 0
  );

  // Minutos ya estudiados: solo cuentan si el día es hoy.
  const availability = computeAvailability({
    day,
    now,
    periods,
    weeklyHoursCap: ctx.weeklyHoursCap,
    studiedMinutes: isToday ? studiedForBudget : 0,
  });

  // Techo declarado por el alumno (si lo hay), cruzado con el tiempo real que
  // queda y con lo que ya está en marcha.
  const declaredBudget =
    typeof options.budgetMinutes === 'number' && options.budgetMinutes > 0
      ? Math.round(options.budgetMinutes)
      : null;
  const effectiveMinutes = Math.max(
    0,
    Math.floor(
      (declaredBudget !== null
        ? Math.min(availability.availableMinutes, declaredBudget)
        : availability.availableMinutes) - reservedMinutes
    )
  );

  // Lo pendiente de días anteriores vuelve, con lo que faltaba, a los dos
  // primeros huecos. Se marca como abandonado el resto: no se acumula deuda.
  // Ojo: solo al generar HOY se rescatan los restos de días anteriores. Si se
  // hiciera al generar los días que vienen, el día 2 marcaría como abandonado lo
  // recién creado para el día 1 (su fecha ya es «anterior») y la semana entera
  // se borraría a sí misma.
  const stale = isToday
    ? await prisma.studyBlock.findMany({
        where: {
          date: { lt: start },
          isCompleted: false,
          status: { in: ['pendiente', 'parcial', 'en_curso'] },
        },
        orderBy: { date: 'desc' },
        select: { id: true, topicId: true, durationMinutes: true, spentMinutes: true, status: true },
      })
    : [];

  const carryTopicIds = new Set<string>();
  let carried = 0;
  for (const block of stale) {
    const decision = rescheduleSession({
      durationMinutes: block.durationMinutes,
      spentMinutes: block.spentMinutes,
    });
    if (decision.keep && carried < 2 && !carryTopicIds.has(block.topicId)) {
      carryTopicIds.add(block.topicId);
      carried += 1;
    }
  }

  const recovery = recoveryPlan(ctx.daysSinceStudy);

  // La prioridad de lo que se quedó a medias sube: ya iba primero ayer.
  const candidates = ctx.candidates.map((candidate) =>
    carryTopicIds.has(candidate.topicId)
      ? { ...candidate, priority: candidate.priority + 15 }
      : candidate
  );
  candidates.sort((a, b) => b.priority - a.priority);

  const sessions = planSessions(candidates, effectiveMinutes, {
    mode: ctx.mode,
    energy: availability.energy,
    recovery: recovery.active,
    maxSessions: recovery.active ? recovery.maxSessions : undefined,
  });

  const origin = recovery.active ? 'recuperacion' : carried > 0 ? 'reprogramada' : 'plan';

  // Se borran SOLO los bloques pendientes de ese día: lo completado y lo que
  // está en marcha no se toca (nadie pierde una sesión empezada).
  await prisma.studyBlock.deleteMany({
    where: {
      date: { gte: start, lt: end },
      isCompleted: false,
      status: 'pendiente',
    },
  });

  if (stale.length > 0) {
    await prisma.studyBlock.updateMany({
      where: { id: { in: stale.map((block) => block.id) } },
      data: { status: 'abandonada' },
    });
  }

  let createdAt = 0;
  let plannedMinutes = 0;

  for (const session of sessions) {
    await prisma.studyBlock.create({
      data: {
        topicId: session.candidate.topicId,
        date: start,
        durationMinutes: session.durationMinutes,
        technique: session.technique,
        mode: ctx.mode,
        isCompleted: false,
        orderIndex: session.orderIndex,
        objective: session.objective,
        reason: session.reason,
        material: session.material,
        stage: session.stage,
        breakMinutes: session.breakMinutes,
        status: 'pendiente',
        priorityScore: session.candidate.priority,
        origin,
        spentMinutes: 0,
      },
    });
    createdAt += 1;
    plannedMinutes += session.durationMinutes;
  }

  // 5. Tarjetas SM-2 que vencen hoy: Active Recall obligatorio en el plan.
  //
  // No se inyecta la unidad entera: se crea una sesión corta (15 min) por cada
  // una de las dos unidades con más tarjetas vencidas. Así el repaso espaciado
  // deja de ser una pantalla aparte y aparece en la agenda del día.
  if (isToday && effectiveMinutes >= 10) {
    try {
      const dueGroups = (await dueReviewCardsByTopic(now)).slice(0, 2);
      if (dueGroups.length > 0) {
        const dueTopics = await prisma.topic.findMany({
          where: { id: { in: dueGroups.map((group) => group.topicId) } },
          select: { id: true, title: true, subject: { select: { isTracked: true } } },
        });
        const alreadyScheduled = new Set(
          (
            await prisma.studyBlock.findMany({
              where: { date: { gte: start, lt: end }, technique: 'srs_review' },
              select: { topicId: true },
            })
          ).map((block) => block.topicId)
        );

        let injected = 0;
        for (const group of dueGroups) {
          const topic = dueTopics.find((row) => row.id === group.topicId);
          if (!topic || !topic.subject.isTracked || alreadyScheduled.has(topic.id)) continue;

          await prisma.studyBlock.create({
            data: {
              topicId: topic.id,
              date: start,
              durationMinutes: 15,
              technique: 'srs_review',
              mode: ctx.mode,
              isCompleted: false,
              orderIndex: 90 + injected,
              objective: `Active Recall: ${group.count} tarjeta(s) vencidas de «${topic.title}»`,
              reason:
                'Repaso espaciado obligatorio (SM-2): estas tarjetas vencen hoy. No es una sugerencia del plan: es recuperación activa programada.',
              material: 'Flashcards y tests del cuaderno · motor SM-2',
              stage: 'repaso',
              breakMinutes: 5,
              status: 'pendiente',
              priorityScore: 88,
              origin: 'plan',
              spentMinutes: 0,
            },
          });

          alreadyScheduled.add(topic.id);
          injected += 1;
          createdAt += 1;
          plannedMinutes += 15;
        }
      }
    } catch (error) {
      // El plan no puede caerse porque falle el repaso de tarjetas.
      console.error('[plan] no se pudo inyectar el repaso SM-2 de hoy:', error);
    }
  }

  return {
    created: createdAt,
    plannedMinutes,
    availableMinutes: effectiveMinutes,
    skipped: false,
    carried,
    abandoned: stale.length,
    reason:
      createdAt === 0
        ? effectiveMinutes < 10
          ? 'No hay ventana suficiente para una sesión (mínimo 10 minutos): ya has cubierto el tiempo de hoy.'
          : 'No queda trabajo pendiente que merezca una sesión.'
        : null,
  };
}

/** Rehace el plan de los próximos siete días con duraciones variables. */
export async function regenerateWeekPlan(mode?: StudyMode): Promise<{
  success: boolean;
  days: number;
  count: number;
  plannedMinutes: number;
  weeklyHoursCap: number;
}> {
  const now = new Date();
  if (mode) {
    await updateDefaultProfile({ studyMode: mode });
  }

  // Una primera pasada guarda hoy (con el tiempo que queda de verdad); las
  // siguientes generan los días que vienen completos.
  let count = 0;
  let plannedMinutes = 0;
  for (let offset = 0; offset < 7; offset++) {
    const day = new Date(startOfDay(now).getTime() + offset * DAY_MS);
    const result = await persistDayPlan({ day, now });
    count += result.created;
    plannedMinutes += result.plannedMinutes;
  }

  const user = await prisma.userProfile.findUnique({ where: { id: 'user_default' } });

  return {
    success: true,
    days: 7,
    count,
    plannedMinutes,
    weeklyHoursCap: user?.weeklyHoursCap ?? 0,
  };
}

/* ------------------------------------------------------------------ */
/* 4. La vista «Hoy toca esto»                                          */
/* ------------------------------------------------------------------ */

export interface DayPlan {
  generatedAtIso: string;
  dayKey: string;
  availableMinutes: number;
  plannedMinutes: number;
  breakMinutes: number;
  wallMinutes: number;
  completedMinutes: number;
  studiedMinutes: number;
  windowLabel: string;
  availabilityReason: string;
  energy: EnergyLevel;
  headline: string;
  sessions: DayPlanSessionView[];
  micro: MicroTask[];
  recovery: RecoveryPlan;
  dueReviews: number;
  errorsOpen: number;
  rescheduled: number;
  reducedScope: boolean;
  emptyReason: string | null;
  calibration: Record<string, number>;
  /** Reprogramación de lo que se quedó a medias hoy mismo. */
  paused: DayPlanSessionView[];
}

function isoDay(date: Date): string {
  const copy = startOfDay(date);
  return `${copy.getFullYear()}-${String(copy.getMonth() + 1).padStart(2, '0')}-${String(copy.getDate()).padStart(2, '0')}`;
}

/** Lee el plan guardado de hoy y lo completa con el contexto vivo. */
export async function computeDayPlan(now: Date = new Date()): Promise<DayPlan> {
  const ctx = await loadPlanningContext(now);
  const todayStart = startOfDay(now);
  const periods = ctx.periodByDay.get(todayStart.getDay()) ?? [];

  const availability = computeAvailability({
    day: todayStart,
    now,
    periods,
    weeklyHoursCap: ctx.weeklyHoursCap,
    studiedMinutes: ctx.studiedMinutesToday,
  });

  const rows = await prisma.studyBlock.findMany({
    where: { date: { gte: todayStart, lt: new Date(todayStart.getTime() + DAY_MS) } },
    include: { topic: { include: { subject: true } } },
    orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }],
  });

  const sessions: DayPlanSessionView[] = rows.map((row) => ({
    id: row.id,
    topicId: row.topicId,
    topicTitle: row.topic.title,
    unitNumber: row.topic.unitNumber,
    subjectId: row.topic.subjectId,
    subjectName: row.topic.subject.name,
    subjectColor: row.topic.subject.color,
    durationMinutes: row.durationMinutes,
    breakMinutes: row.breakMinutes,
    stage: (row.stage as SessionStage) ?? 'practica',
    technique: row.technique,
    objective: row.objective ?? row.topic.title,
    reason: row.reason ?? '',
    material: row.material ?? '',
    status: row.status,
    origin: row.origin,
    isCompleted: row.isCompleted,
    spentMinutes: row.spentMinutes,
    orderIndex: row.orderIndex,
    mastery: row.topic.masteryLevel,
    masterySource: row.topic.masterySource,
  }));

  const active = sessions.filter((session) => !session.isCompleted && session.status !== 'abandonada');
  const paused = active.filter((session) => session.status === 'parcial');
  const plannedMinutes = active
    .filter((session) => session.status !== 'parcial')
    .reduce((acc, session) => acc + session.durationMinutes, 0);
  const pendingMinutes = paused.reduce(
    (acc, session) => acc + Math.max(0, session.durationMinutes - session.spentMinutes),
    0
  );
  const breakMinutes = active.reduce((acc, session) => acc + session.breakMinutes, 0);
  const completedMinutes = sessions
    .filter((session) => session.isCompleted)
    .reduce((acc, session) => acc + session.durationMinutes, 0);

  const recovery = recoveryPlan(ctx.daysSinceStudy);
  const dueCount = ctx.dueReviews;

  const headline =
    active.length > 0
      ? `Hoy toca esto: ${active.length} sesión(es). ${hoursLabel(plannedMinutes + pendingMinutes)} de trabajo${
          breakMinutes > 0 ? ` y ${breakMinutes} min de descanso` : ''
        } en ${hoursLabel(availability.availableMinutes)} disponibles.`
      : availability.availableMinutes < 10
        ? 'Hoy ya no queda ventana de estudio. Mañana el plan se recalcula solo.'
        : 'No hay sesiones pendientes: el plan está al día.';

  const emptyReason =
    active.length === 0
      ? !ctx.hasTemario
        ? 'Todavía no hay temario cargado: sin unidades no hay nada que planificar. Empieza por la puesta a punto.'
        : availability.availableMinutes < 10
          ? 'No queda tiempo útil hoy (mínimo 10 minutos para una sesión).'
          : 'Nada pendiente. Si quieres adelantar, pulsa «Recalcular».'
      : null;

  return {
    generatedAtIso: new Date().toISOString(),
    dayKey: isoDay(todayStart),
    availableMinutes: availability.availableMinutes,
    plannedMinutes: plannedMinutes + pendingMinutes,
    breakMinutes,
    wallMinutes: plannedMinutes + pendingMinutes + breakMinutes,
    completedMinutes,
    studiedMinutes: ctx.studiedMinutesToday,
    windowLabel: availability.windowLabel,
    availabilityReason: availability.reason,
    energy: availability.energy,
    headline,
    sessions,
    micro: microTasks({
      errorsOpen: ctx.errorsOpen,
      dueReviews: dueCount,
    }),
    recovery,
    dueReviews: dueCount,
    errorsOpen: ctx.errorsOpen,
    rescheduled: rows.filter((row) => row.origin === 'reprogramada').length,
    reducedScope: recovery.active,
    emptyReason,
    calibration: ctx.calibration,
    paused,
  };
}

/**
 * Una sola comprobación/generación a la vez por proceso.
 *
 * Sin esto, dos pestañas abiertas (o la precarga de Next) pueden pedir el plan
 * a la vez y lanzar dos regeneraciones completas de la semana. En SQLite la
 * segunda espera a la primera, y mientras tanto todas las navegaciones se
 * quedan en «cargando». Compartir la misma promesa lo evita de raíz.
 */
let ensureInFlight: Promise<DayPlan> | null = null;
/** Día local en el que ya se comprobó el plan: no se repite en cada clic. */
let ensuredDayKey: string | null = null;

/**
 * Se llama al abrir el Cuartel: si hoy no hay plan (o solo quedan sesiones
 * cerradas), lo genera. Es idempotente y barato: si ya hay sesiones vivas, no
 * escribe nada. Así la app funciona sin que haya que organizar nada.
 */
export async function ensureTodayPlan(now: Date = new Date()): Promise<DayPlan> {
  const dayKey = isoDay(now);

  // Ya se miró hoy: leer el plan es barato y no puede bloquear a nadie.
  if (ensuredDayKey === dayKey) return computeDayPlan(now);

  // Hay una comprobación en marcha: se espera a ESA, no se lanza otra.
  if (ensureInFlight) return ensureInFlight;

  ensureInFlight = (async () => {
    try {
      const todayStart = startOfDay(now);
      // Un plan «vivo» es el que ha hecho este motor: trae objetivo y motivo. Los
      // bloques viejos (45 min fijos, sin objetivo) no cuentan: si existen, se
      // rehace la semana entera una sola vez en vez de arrastrarlos para siempre.
      //
      // Cuenta también lo ya completado: si has terminado el día, NO se regenera
      // el plan en cada visita (te volvería a llenar la tarde con trabajo nuevo).
      const live = await prisma.studyBlock.count({
        where: {
          date: { gte: todayStart, lt: new Date(todayStart.getTime() + DAY_MS) },
          objective: { not: null },
          status: { not: 'abandonada' },
        },
      });

      if (live === 0) {
        await regenerateWeekPlan();
      }

      // Se marca aunque el motor no haya podido crear sesiones (por ejemplo,
      // sin ventana de tiempo). Si no, cada visita volvería a regenerar la
      // semana entera: exactamente el bucle de escrituras que congelaba la app.
      ensuredDayKey = dayKey;
    } catch (error) {
      // Que la generación falle no puede tumbar el Cuartel: se enseña lo que
      // haya, pero se deja rastro para que el vigilante pueda verlo.
      console.error('[plan] no se pudo generar el plan del día:', error);
    } finally {
      ensureInFlight = null;
    }

    return computeDayPlan(now);
  })();

  return ensureInFlight;
}

/** Fuerza la regeneración de hoy (botón «Recalcular»). */
export async function regenerateTodayPlan(now: Date = new Date()): Promise<DayPlan> {
  await persistDayPlan({ day: startOfDay(now), now, force: true });
  return computeDayPlan(now);
}

/* ------------------------------------------------------------------ */
/* 5. Revisión diaria y actualización del plan                          */
/* ------------------------------------------------------------------ */

export interface DayReviewTopic {
  title: string;
  subjectName: string;
  subjectColor: string;
}

/**
 * Foto del avance real de hoy, sin inventar nada: lo cerrado, lo que está a
 * medias, lo pendiente y lo que se quedó de días anteriores. Es lo que se enseña
 * antes de recalcular y lo que explica por qué el plan nuevo es distinto.
 */
export interface DayReview {
  dayKey: string;
  completedBlocks: number;
  completedMinutes: number;
  completedTopics: DayReviewTopic[];
  inProgressBlocks: number;
  inProgressMinutes: number;
  pendingBlocks: number;
  pendingMinutes: number;
  delayedBlocks: number;
  delayedMinutes: number;
  delayedTopics: Array<DayReviewTopic & { daysLate: number }>;
  studiedMinutes: number;
  availableMinutes: number;
  /** Minutos que quedan por hacer hoy (pendientes + lo que falta de las pausadas). */
  remainingMinutes: number;
  dueReviews: number;
  openErrors: number;
  exams: Array<{
    id: string;
    subjectName: string;
    subjectColor: string;
    title: string;
    days: number;
    format: string;
  }>;
}

/** Revisa qué se ha completado hoy y qué se ha retrasado. */
export async function reviewDayProgress(now: Date = new Date()): Promise<DayReview> {
  const todayStart = startOfDay(now);
  const ctx = await loadPlanningContext(now);
  const periods = ctx.periodByDay.get(todayStart.getDay()) ?? [];
  const availability = computeAvailability({
    day: todayStart,
    now,
    periods,
    weeklyHoursCap: ctx.weeklyHoursCap,
    studiedMinutes: ctx.studiedMinutesToday,
  });

  const [rows, delayedRows, exams] = await Promise.all([
    prisma.studyBlock.findMany({
      where: { date: { gte: todayStart, lt: new Date(todayStart.getTime() + DAY_MS) } },
      include: { topic: { include: { subject: true } } },
      orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }],
    }),
    // Lo que quedó vivo de días anteriores: es el «retraso» real, no una
    // suposición. Se limita para que la tarjeta no se convierta en un muro.
    prisma.studyBlock.findMany({
      where: {
        date: { lt: todayStart },
        isCompleted: false,
        status: { in: ['pendiente', 'parcial', 'en_curso'] },
      },
      include: { topic: { include: { subject: true } } },
      orderBy: { date: 'desc' },
      take: 20,
    }),
    prisma.exam.findMany({
      where: { isCompleted: false, examDate: { gte: todayStart } },
      include: { subject: true },
      orderBy: { examDate: 'asc' },
      take: 5,
    }),
  ]);

  const completed = rows.filter((row) => row.isCompleted);
  const inProgress = rows.filter(
    (row) => !row.isCompleted && (row.status === 'parcial' || row.status === 'en_curso')
  );
  const pending = rows.filter(
    (row) =>
      !row.isCompleted && row.status !== 'abandonada' && row.status !== 'parcial' && row.status !== 'en_curso'
  );

  const completedMap = new Map<string, DayReviewTopic>();
  for (const row of completed) {
    completedMap.set(row.topicId, {
      title: row.topic.title,
      subjectName: row.topic.subject.name,
      subjectColor: row.topic.subject.color,
    });
  }

  const delayedMap = new Map<string, DayReviewTopic & { daysLate: number }>();
  for (const row of delayedRows) {
    if (delayedMap.has(row.topicId)) continue;
    delayedMap.set(row.topicId, {
      title: row.topic.title,
      subjectName: row.topic.subject.name,
      subjectColor: row.topic.subject.color,
      daysLate: Math.max(
        1,
        Math.round((todayStart.getTime() - startOfDay(row.date).getTime()) / DAY_MS)
      ),
    });
  }

  const pendingMinutes = pending.reduce((total, row) => total + row.durationMinutes, 0);
  const inProgressMinutes = inProgress.reduce(
    (total, row) => total + Math.max(0, row.durationMinutes - row.spentMinutes),
    0
  );

  return {
    dayKey: isoDay(todayStart),
    completedBlocks: completed.length,
    completedMinutes: completed.reduce((total, row) => total + row.durationMinutes, 0),
    completedTopics: [...completedMap.values()],
    inProgressBlocks: inProgress.length,
    inProgressMinutes,
    pendingBlocks: pending.length,
    pendingMinutes,
    delayedBlocks: delayedRows.length,
    delayedMinutes: delayedRows.reduce((total, row) => total + row.durationMinutes, 0),
    delayedTopics: [...delayedMap.values()].sort((a, b) => b.daysLate - a.daysLate).slice(0, 6),
    studiedMinutes: ctx.studiedMinutesToday,
    availableMinutes: availability.availableMinutes,
    remainingMinutes: pendingMinutes + inProgressMinutes,
    dueReviews: ctx.dueReviews,
    openErrors: ctx.errorsOpen,
    exams: exams.map((exam) => ({
      id: exam.id,
      subjectName: exam.subject.name,
      subjectColor: exam.subject.color,
      title: exam.title,
      days: Math.max(0, daysBetween(now, new Date(exam.examDate))),
      format: exam.examFormat ?? 'test',
    })),
  };
}

export interface ReplanResult {
  plan: DayPlan;
  review: DayReview;
  created: number;
  carried: number;
  abandoned: number;
  availableMinutes: number;
  reason: string | null;
}

/**
 * «Actualizar Plan de Hoy»: mira el avance real y rehace lo que queda.
 *
 * No toca lo completado ni lo que está en marcha; cierra lo viejo que ya no
 * cabe, sube la prioridad de lo que se quedó a medias y reparte el tiempo que
 * de verdad queda hoy entre los exámenes y el temario activos.
 */
export async function replanToday(
  options: { now?: Date; budgetMinutes?: number; mode?: StudyMode } = {}
): Promise<ReplanResult> {
  const now = options.now ?? new Date();
  if (options.mode) {
    await updateDefaultProfile({ studyMode: options.mode });
  }

  const persisted = await persistDayPlan({
    day: startOfDay(now),
    now,
    force: true,
    budgetMinutes: options.budgetMinutes,
  });
  const [plan, review] = await Promise.all([computeDayPlan(now), reviewDayProgress(now)]);

  return {
    plan,
    review,
    created: persisted.created,
    carried: persisted.carried,
    abandoned: persisted.abandoned,
    availableMinutes: persisted.availableMinutes,
    reason: persisted.reason,
  };
}

/** Unidades con probabilidad baja de recuerdo el día del examen. */
export async function examCriticalTopics(
  now: Date = new Date(),
  limit = 5
): Promise<Array<{ topicId: string; title: string; subjectName: string; recall: number; daysToExam: number }>> {
  const todayStart = startOfDay(now);
  const topics = await prisma.topic.findMany({
    where: { srsStability: { not: null }, lastReviewedAt: { not: null } },
    include: {
      subject: {
        include: {
          exams: { where: { isCompleted: false, examDate: { gte: todayStart } }, orderBy: { examDate: 'asc' }, take: 1 },
        },
      },
    },
  });

  const out: Array<{ topicId: string; title: string; subjectName: string; recall: number; daysToExam: number }> = [];
  for (const topic of topics) {
    const exam = topic.subject.exams[0];
    if (!exam) continue;
    const recall = recallAtExam(
      { stability: topic.srsStability ?? 0, lastReviewedAt: topic.lastReviewedAt },
      new Date(exam.examDate),
      now
    );
    if (recall === null) continue;
    if (recall >= 85) continue;
    out.push({
      topicId: topic.id,
      title: topic.title,
      subjectName: topic.subject.name,
      recall,
      daysToExam: daysBetween(now, new Date(exam.examDate)),
    });
  }

  out.sort((a, b) => a.recall - b.recall || a.daysToExam - b.daysToExam);
  return out.slice(0, limit);
}
