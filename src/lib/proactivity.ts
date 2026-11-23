/**
 * Motor determinista de proactividad diaria (Paso 13).
 *
 * Reglas puras, sin Prisma, sin red y sin IA: recibe la foto que el planificador
 * ya decidió (`DayPlan`) y los datos reales del expediente, y devuelve **una**
 * propuesta accionable con su motivo. La app no vuelve a puntuar el día: cita la
 * decisión del plan y añade lo que el plan no puede saber (racha en riesgo,
 * horas de silencio, descartes del alumno).
 *
 * Principio de honestidad: si no hay mediciones, no se inventa un riesgo. Se
 * propone medir o se calla.
 *
 * Blindaje: las fechas se convierten con `toDate` antes de tocarlas y cada
 * función exportada pasa por `selfHealing`. Motivo real: `unstable_cache`
 * devuelve JSON, así que un `examDate` declarado `Date` llega como `string` y
 * `getFullYear()` sobre él tiraba la página con `TypeError`.
 */

import {
  selfHealing,
  toDate,
  toFiniteNumber,
  type DateLike,
} from './selfHealing';

export type ProactiveKind =
  | 'examen'
  | 'repaso'
  | 'errores'
  | 'racha'
  | 'empezar'
  | 'medir';

export type ProactiveStage = 'ESO' | 'BACHILLERATO' | 'UNIVERSIDAD';

/** Franja de silencio local: de 22:00 a 08:00 no se interrumpe al alumno. */
export const QUIET_START_MINUTES = 22 * 60;
export const QUIET_END_MINUTES = 8 * 60;

/** Prefijo de la clave de descartes en el navegador (una por día). */
export const PROACTIVE_STORAGE_PREFIX = 'brainup.proactive';

export interface ProactiveLocalClock {
  /** Día local del alumno en formato YYYY-MM-DD. */
  dayKey: string;
  /** Minutos desde medianoche en su zona. */
  minutes: number;
}

/**
 * Reloj local del alumno. En Netlify/Render el proceso corre en UTC: usar la
 * hora del servidor cambiaría el día y la franja de silencio.
 */
/** Reloj sin `Intl`: último recurso si la zona es inválida o el formato falla. */
function plainClock(at: Date): ProactiveLocalClock {
  return {
    dayKey: `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(
      at.getDate()
    ).padStart(2, '0')}`,
    minutes: at.getHours() * 60 + at.getMinutes(),
  };
}

function localClockUnsafe(now: DateLike, timeZone?: string | null): ProactiveLocalClock {
  const at = toDate(now, new Date(), 'proactivity.localClock');
  const zone =
    typeof timeZone === 'string' && timeZone.trim() ? timeZone.trim() : 'Europe/Madrid';

  const read = (candidate: string): ProactiveLocalClock | null => {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: candidate,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).formatToParts(at);
      const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
      const year = get('year');
      const month = get('month');
      const day = get('day');
      const hour = Number(get('hour'));
      const minute = Number(get('minute'));
      if (!/^\d{4}$/.test(year) || !/^\d{2}$/.test(month) || !/^\d{2}$/.test(day)) return null;
      if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
      return {
        dayKey: `${year}-${month}-${day}`,
        minutes: hour * 60 + minute,
      };
    } catch {
      return null;
    }
  };

  return read(zone) ?? read('Europe/Madrid') ?? plainClock(at);
}

export const localClock = selfHealing('proactivity.localClock', localClockUnsafe, () =>
  plainClock(new Date())
);

function dayKeyForUnsafe(now: DateLike, timeZone?: string | null): string {
  return localClock(now, timeZone).dayKey;
}

export const dayKeyFor = selfHealing('proactivity.dayKeyFor', dayKeyForUnsafe, () =>
  plainClock(new Date()).dayKey
);

/**
 * Días de calendario entre dos instantes en la zona del alumno. Un examen a las
 * 23:30 de hoy sigue siendo «mañana» si en su zona ya es el día siguiente.
 */
function localDaysBetweenUnsafe(
  from: DateLike,
  to: DateLike,
  timeZone?: string | null
): number {
  const start = Date.parse(`${dayKeyFor(from, timeZone)}T00:00:00Z`);
  const end = Date.parse(`${dayKeyFor(to, timeZone)}T00:00:00Z`);
  // Fecha ilegible: 0 («no lo sé») y la tarjeta no acusa un examen inexistente.
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.round((end - start) / 86_400_000);
}

export const localDaysBetween = selfHealing(
  'proactivity.localDaysBetween',
  localDaysBetweenUnsafe,
  0
);

/** ¿Estos minutos locales caen en la franja de silencio? */
export function isQuietMinutes(minutes: number): boolean {
  return minutes >= QUIET_START_MINUTES || minutes < QUIET_END_MINUTES;
}

/** ¿Ahora es hora de silencio en la zona del alumno? */
function isQuietHourUnsafe(now: DateLike, timeZone?: string | null): boolean {
  return isQuietMinutes(localClock(now, timeZone).minutes);
}

// Si el reloj no se puede leer, se elige silencio: no molestar es el fallo seguro.
export const isQuietHour = selfHealing('proactivity.isQuietHour', isQuietHourUnsafe, true);

/**
 * Valida la hora de un aviso. No se puede guardar una hora que el motor luego
 * va a descartar: el alumno creería que tiene aviso y no lo tendría nunca.
 */
export function validateReminderTime(
  value: string
): { ok: true; time: string; minutes: number } | { ok: false; error: string } {
  const clean = String(value ?? '').trim();
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(clean);
  if (!match) {
    return { ok: false, error: 'La hora debe tener el formato HH:MM.' };
  }

  const minutes = Number(match[1]) * 60 + Number(match[2]);
  if (isQuietMinutes(minutes)) {
    return {
      ok: false,
      error: 'La franja de 22:00 a 08:00 es de silencio: elige una hora fuera de ella.',
    };
  }

  return { ok: true, time: clean, minutes };
}

/* ------------------------------------------------------------------ */
/* Contratos mínimos: lo que se lee del plan, sin acoplarse a Prisma    */
/* ------------------------------------------------------------------ */

export interface ProactivePlanSession {
  id?: string;
  topicId?: string;
  topicTitle: string;
  subjectName: string;
  status?: string | null;
  isCompleted?: boolean;
  durationMinutes?: number;
  reason?: string | null;
  objective?: string | null;
}

/** La parte de `DayPlan` que necesita la proactividad. */
export interface ProactivePlan {
  sessions: ProactivePlanSession[];
  dueReviews?: number;
  errorsOpen?: number;
  headline?: string | null;
  studiedMinutes?: number;
}

export interface ProactiveExam {
  title: string;
  /** Días hasta el examen (0 = hoy). */
  days: number;
  weight?: number | null;
  subjectName?: string | null;
}

export interface ProactiveInput {
  /** Acepta Date, ISO o milisegundos: la caché devuelve strings. */
  now: DateLike;
  timezone?: string | null;
  stage?: ProactiveStage | string | null;
  plan: ProactivePlan | null;
  nextExam?: ProactiveExam | null;
  streak?: { current: number; studiedToday: boolean } | null;
  /** Unidades con nivel MEDIDO. Sin esto no se puede hablar de flaquezas. */
  measuredUnits?: number | null;
  /** Tipos que el alumno ya ha descartado hoy (localStorage). */
  dismissedKinds?: readonly string[] | null;
}

export interface ProactiveProposal {
  kind: ProactiveKind;
  title: string;
  detail: string;
  action: { label: string; href: string };
  evidence: string[];
  urgency: number;
}

export interface ProactiveDecision {
  primary: ProactiveProposal | null;
  secondary: ProactiveProposal[];
  /** Es hora de silencio: se puede pintar la tarjeta, pero no notificar. */
  quiet: boolean;
  dayKey: string;
  /** Por qué no hay propuesta (solo si `primary` es null). */
  reason: string | null;
}

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function daysLabel(days: number): string {
  if (days <= 0) return 'hoy';
  if (days === 1) return 'mañana';
  return `en ${days} días`;
}

function nextLiveSession(plan: ProactivePlan | null): ProactivePlanSession | null {
  if (!plan || !Array.isArray(plan.sessions)) return null;
  const live = plan.sessions.filter(
    (session) => session && !session.isCompleted && session.status !== 'abandonada'
  );
  if (live.length === 0) return null;
  return live.find((session) => session.status === 'parcial') ?? live[0];
}

function sessionHref(): string {
  // «Hoy toca esto» marca el bloque actual con este ancla.
  return '/#ahora';
}

/* ------------------------------------------------------------------ */
/* Ranking                                                             */
/* ------------------------------------------------------------------ */

/**
 * Prioridad fija del Paso 13: examen → repaso vencido → errores → racha →
 * siguiente bloque del plan. «Medir» queda al final y nunca se presenta como
 * riesgo: es una invitación a tener datos, no una acusación.
 */
function buildProactiveProposalUnsafe(input: ProactiveInput): ProactiveDecision {
  // La caché y los JSON pueden entregar `null` donde el tipo promete un objeto.
  const source = (input ?? {}) as ProactiveInput;
  const clock = localClock(source.now, source.timezone);
  const quiet = isQuietMinutes(clock.minutes);
  const dismissed = new Set(
    Array.isArray(source.dismissedKinds) ? source.dismissedKinds : []
  );
  const plan =
    source.plan && typeof source.plan === 'object' ? source.plan : null;
  const nextSession = nextLiveSession(plan);
  const dueReviews = Math.max(0, toFiniteNumber(plan?.dueReviews, 0, 'proactivity.repasos'));
  const openErrors = Math.max(0, toFiniteNumber(plan?.errorsOpen, 0, 'proactivity.errores'));
  const measuredUnits = Math.max(
    0,
    toFiniteNumber(source.measuredUnits, 0, 'proactivity.medidas')
  );
  const streak =
    source.streak && typeof source.streak === 'object' ? source.streak : null;
  const streakDays = streak
    ? toFiniteNumber(streak.current, 0, 'proactivity.racha')
    : 0;
  const exam =
    source.nextExam && typeof source.nextExam === 'object' ? source.nextExam : null;
  const examDays = exam
    ? toFiniteNumber(exam.days, Number.NaN, 'proactivity.examen')
    : Number.NaN;

  const candidates: ProactiveProposal[] = [];

  // 1. Examen próximo: una fecha real, no una predicción.
  if (exam && Number.isFinite(examDays) && examDays >= 0 && examDays <= 14) {
    const near = examDays <= 7;
    const examTitle =
      typeof exam.title === 'string' && exam.title.trim() ? exam.title.trim() : 'Examen';
    const examWeight = toFiniteNumber(exam.weight, 0, 'proactivity.peso');
    const examSubject =
      typeof exam.subjectName === 'string' && exam.subjectName.trim()
        ? exam.subjectName.trim()
        : null;
    candidates.push({
      kind: 'examen',
      title: `${examTitle} ${daysLabel(examDays)}`,
      detail: near
        ? 'El plan ya coloca esta materia arriba. Hoy conviene asegurar lo que más pondera, no empezar un tema nuevo.'
        : 'Todavía hay margen, pero el examen ya tiene fecha. Un bloque hoy evita que se junte con la semana anterior.',
      action: { label: 'Ver el examen', href: '/examenes' },
      evidence: [
        examSubject ? `Materia: ${examSubject}` : null,
        examDays <= 0 ? 'Es hoy' : `${plural(examDays, 'día', 'días')} restantes`,
        examWeight > 0 ? `Peso ${examWeight}` : null,
      ].filter((item): item is string => Boolean(item)),
      urgency: near ? 90 - examDays * 2 : 55,
    });
  }

  // 2. Repaso vencido: el plan ya lo cuenta; aquí se dice cuánto.
  if (dueReviews > 0) {
    candidates.push({
      kind: 'repaso',
      title: plural(dueReviews, 'repaso vencido', 'repasos vencidos'),
      detail:
        'Repasar lo que ya sabías rinde más que avanzar: el plan ya reserva un hueco para ello. Empieza por lo más vencido.',
      action: { label: 'Repasar ahora', href: '/repaso' },
      evidence: [
        plural(dueReviews, 'unidad vencida', 'unidades vencidas'),
        plan?.headline ? `Plan de hoy: ${plan.headline}` : null,
      ].filter((item): item is string => Boolean(item)),
      urgency: 70 + Math.min(12, dueReviews * 2),
    });
  }

  // 3. Errores abiertos: trabajo concreto, no teoría otra vez.
  if (openErrors > 0) {
    candidates.push({
      kind: 'errores',
      title: plural(openErrors, 'error sin dominar', 'errores sin dominar'),
      detail:
        'Son fallos que ya has cometido una vez. Cerrarlos vale más que repetir la teoría que ya entiendes.',
      action: { label: 'Abrir el banco', href: '/errores' },
      evidence: [
        plural(openErrors, 'ficha pendiente', 'fichas pendientes'),
        measuredUnits === 0 ? 'Sin mediciones todavía: esto sale de tus propios fallos' : null,
      ].filter((item): item is string => Boolean(item)),
      urgency: 50 + Math.min(12, openErrors),
    });
  }

  // 4. Racha en riesgo: solo a partir de las 18:00 y con racha viva.
  if (
    streak &&
    streakDays > 0 &&
    streak.studiedToday !== true &&
    clock.minutes >= 18 * 60
  ) {
    candidates.push({
      kind: 'racha',
      title: `Tu racha de ${streakDays} ${streakDays === 1 ? 'día' : 'días'} sigue viva`,
      detail:
        'No hace falta una sesión larga: un bloque corto hoy mantiene la cadena sin convertir la noche en una obligación.',
      action: nextSession
        ? { label: 'Empezar el bloque', href: sessionHref() }
        : { label: 'Ver repaso', href: '/repaso' },
      evidence: [
        'Todavía no has registrado estudio hoy',
        nextSession ? `Siguiente: ${nextSession.topicTitle}` : 'Sin bloque pendiente en el plan',
      ],
      urgency: 40 + Math.min(10, streakDays),
    });
  }

  // 5. El siguiente bloque del plan: la propuesta más honesta si no hay riesgo.
  if (nextSession) {
    const minutes = toFiniteNumber(
      nextSession.durationMinutes,
      0,
      'proactivity.duracion'
    );
    const sessionTitle =
      typeof nextSession.topicTitle === 'string' && nextSession.topicTitle.trim()
        ? nextSession.topicTitle.trim()
        : 'tu siguiente bloque';
    const sessionReason = nextSession.reason?.trim?.() ?? '';
    const sessionObjective = nextSession.objective?.trim?.() ?? '';
    const sessionSubject =
      typeof nextSession.subjectName === 'string' && nextSession.subjectName.trim()
        ? nextSession.subjectName.trim()
        : null;
    candidates.push({
      kind: 'empezar',
      title: `Ahora: ${sessionTitle}`,
      detail:
        sessionReason ||
        sessionObjective ||
        'Es el siguiente bloque que el plan ha decidido para hoy.',
      action: { label: 'Empezar', href: sessionHref() },
      evidence: [
        sessionSubject,
        minutes > 0 ? `${minutes} min` : null,
      ].filter((item): item is string => Boolean(item)),
      urgency: 35,
    });
  }

  // 6. Sin datos: se propone medir, nunca se inventa un punto débil.
  if (measuredUnits === 0 && candidates.length === 0) {
    candidates.push({
      kind: 'medir',
      title: 'Primero, mide tu nivel',
      detail:
        'Todavía no hay ninguna unidad con nivel medido. Sin ese dato no puedo decirte qué se te da mal: solo puedo invitarte a averiguarlo.',
      action: { label: 'Medir en el temario', href: '/temario' },
      evidence: ['0 unidades medidas', 'Un diagnóstico corto basta para empezar'],
      urgency: 20,
    });
  }

  const available = candidates
    .filter((proposal) => !dismissed.has(proposal.kind))
    .sort((a, b) => b.urgency - a.urgency);

  if (available.length === 0) {
    return {
      primary: null,
      secondary: [],
      quiet,
      dayKey: clock.dayKey,
      reason:
        dismissed.size > 0
          ? 'Has descartado las propuestas de hoy. El plan sigue disponible en «Hoy toca esto».'
          : 'No hay señales reales que justifiquen una propuesta ahora mismo.',
    };
  }

  return {
    primary: available[0],
    secondary: available.slice(1, 3),
    quiet,
    dayKey: clock.dayKey,
    reason: null,
  };
}

/**
 * La proactividad nunca puede tumbar el Cuartel: si algo se sale de lo previsto,
 * se devuelve «sin propuesta» con el motivo, que la tarjeta ya sabe pintar.
 */
export const buildProactiveProposal = selfHealing(
  'proactivity.buildProactiveProposal',
  buildProactiveProposalUnsafe,
  (): ProactiveDecision => ({
    primary: null,
    secondary: [],
    quiet: true,
    dayKey: plainClock(new Date()).dayKey,
    reason:
      'No he podido leer el reloj o el plan de hoy. El plan sigue disponible en «Hoy toca esto».',
  })
);

/** Clave de localStorage para los descartes de un día concreto. */
export function dismissalStorageKey(dayKey: string): string {
  return `${PROACTIVE_STORAGE_PREFIX}.${dayKey}`;
}

/**
 * Tono de la etapa que la página obtiene de `getStageConfig`. Aquí no se
 * comparan literales de etapa: eso vive solo en `src/lib/stages`.
 */
export interface ProactiveStageTone {
  label: string;
  hasPau: boolean;
  supportsEcts: boolean;
}

/**
 * Línea breve para el saludo del catedrático, adaptada a la etapa.
 *
 * No usa el plan ni la base: se alimenta de lo que la página del tutor ya ha
 * leído (unidad floja medida, unidades sin medir, examen y errores). Sin IA.
 */
export function buildTutorProactiveLine(input: {
  tone: ProactiveStageTone;
  weakTopicLabel?: string | null;
  unmeasuredCount?: number | null;
  examTitle?: string | null;
  examDays?: number | null;
  pendingErrors?: number | null;
}): string | null {
  const tone = input.tone;
  const weak = input.weakTopicLabel?.trim() || null;
  const unmeasured = Math.max(0, input.unmeasuredCount ?? 0);
  const examTitle = input.examTitle?.trim() || null;
  const examDays = input.examDays ?? null;
  const errors = Math.max(0, input.pendingErrors ?? 0);

  if (examTitle && examDays !== null && examDays >= 0) {
    if (tone.supportsEcts) {
      return `Lo más útil hoy: **${examTitle}**, ${daysLabel(examDays)}. Vamos a lo que entra y a lo que más pesa en la asignatura.`;
    }
    if (!tone.hasPau) {
      return `Lo más útil hoy: preparar **${examTitle}**, que cae ${daysLabel(examDays)}. Empezamos por lo que ya sabes y cerramos los huecos.`;
    }
    return `Lo más útil hoy: **${examTitle}**, ${daysLabel(examDays)}. Con la fecha a la vista, cada bloque cuenta para la nota.`;
  }

  if (weak) {
    if (tone.supportsEcts) {
      return `La unidad con peor nivel medido es **${weak}**. La atacamos con problemas y criterio de corrección, no releyendo apuntes.`;
    }
    if (!tone.hasPau) {
      return `La unidad que peor llevas medida es **${weak}**. Hoy basta con arreglar una parte pequeña y comprobar que se queda.`;
    }
    return `La unidad con peor nivel medido es **${weak}**. Es la que más margen de nota tiene: empezamos por ahí.`;
  }

  if (unmeasured > 0) {
    return !tone.hasPau && !tone.supportsEcts
      ? `Todavía no sé tu nivel en ${plural(unmeasured, 'unidad', 'unidades')}. Antes de decirte qué repasar, te hago unas preguntas cortas.`
      : `Todavía no hay ninguna medición real de tu nivel en ${plural(unmeasured, 'unidad', 'unidades')}. No voy a suponer que algo se te da mal: hoy toca medirlo.`;
  }

  if (errors > 0) {
    return !tone.hasPau && !tone.supportsEcts
      ? `Arrastras ${plural(errors, 'fallo', 'fallos')} sin cerrar. Con dos o tres bien trabajados, hoy ya ganas algo.`
      : `Arrastras ${plural(errors, 'error sin dominar', 'errores sin dominar')}. Cerrarlos vale más que volver a leer lo que ya entiendes.`;
  }

  return null;
}
