import { unstable_cache } from 'next/cache';
import { prisma } from './prisma';
import { isTopicStatus, TopicStatus, TOPIC_STATUSES } from './types';

/**
 * Lógica del temario: qué unidad se está dando, cuál toca después, cuánto
 * llevas visto y cuándo terminarás el temario al ritmo actual.
 *
 * La regla de oro es el orden por `unitNumber`: el temario es una secuencia,
 * no una bolsa de temas. Si falta numerar algo, va al final.
 */

export interface TemarioUnit {
  id: string;
  subjectId: string;
  unitNumber: number | null;
  title: string;
  term: number | null;
  status: TopicStatus;
  source: string;
  difficulty: number;
  masteryLevel: number;
  /** De dónde sale ese dominio: si es "sin_medir", nadie lo ha medido. */
  masterySource: string;
  seenInClassAt: string | null;
  /**
   * Cómo explicó el profesor la unidad en clase, con las palabras del alumno.
   *
   * No es una nota interna: es lo que convierte los apuntes del catedrático en
   * los de SU profesor (notación, pasos y criterios de corrección). Viaja con la
   * unidad para que se pueda leer y editar tanto en el temario como en el
   * chequeo de clase.
   *
   * Opcional a propósito: una unidad puede llegar construida desde una consulta
   * que no lo pida, y eso no puede romper la pantalla (se trata como «sin
   * anotar»).
   */
  teacherMethod?: string | null;
}

export interface TemarioStats {
  total: number;
  counts: Record<TopicStatus, number>;
  seen: number;
  progressPct: number;
  currentUnitId: string | null;
  nextUnitId: string | null;
  lastSeenIso: string | null;
  termNow: number | null;
  pacePerWeek: number | null;
  weeksRemaining: number | null;
  projectedFinishIso: string | null;
}

export interface TemarioSubject {
  id: string;
  name: string;
  color: string;
  units: TemarioUnit[];
  stats: TemarioStats;
}

const DAY_MS = 86400000;

/** Ordena las unidades tal y como se estudian: por número, sin número al final. */
export function sortUnits<T extends { unitNumber: number | null; title: string }>(units: T[]): T[] {
  return [...units].sort((a, b) => {
    const na = a.unitNumber ?? Number.MAX_SAFE_INTEGER;
    const nb = b.unitNumber ?? Number.MAX_SAFE_INTEGER;
    if (na !== nb) return na - nb;
    return a.title.localeCompare(b.title, 'es');
  });
}

/** La unidad que se está dando ahora mismo (en curso, o la última vista). */
export function currentUnit(units: TemarioUnit[]): TemarioUnit | null {
  const ordered = sortUnits(units);
  const enCurso = [...ordered].reverse().find((unit) => unit.status === 'en_curso');
  if (enCurso) return enCurso;
  const visto = [...ordered].reverse().find((unit) => unit.status === 'visto' || unit.status === 'repasado');
  return visto ?? null;
}

/** La siguiente unidad por dar: la primera pendiente después de la actual. */
export function nextUnit(units: TemarioUnit[]): TemarioUnit | null {
  const ordered = sortUnits(units);
  const pending = ordered.filter((unit) => unit.status === 'pendiente');
  if (pending.length === 0) return null;

  const reference = ordered.filter((unit) => unit.status !== 'pendiente').pop() ?? null;
  if (!reference) return pending[0];

  const after = pending.find((unit) => (unit.unitNumber ?? 0) > (reference.unitNumber ?? 0));
  return after ?? pending[0];
}

/** Ritmo real de clase: unidades explicadas por semana en las últimas 4 semanas. */
export function classPacePerWeek(units: TemarioUnit[], now = new Date()): number | null {
  const windowMs = 28 * DAY_MS;
  const recent = units.filter((unit) => {
    if (!unit.seenInClassAt) return false;
    const seen = new Date(unit.seenInClassAt).getTime();
    return now.getTime() - seen <= windowMs;
  });
  if (recent.length === 0) return null;
  return Math.round((recent.length / 4) * 10) / 10;
}

export function computeStats(units: TemarioUnit[], now = new Date()): TemarioStats {
  const counts = TOPIC_STATUSES.reduce(
    (acc, status) => ({ ...acc, [status]: units.filter((unit) => unit.status === status).length }),
    {} as Record<TopicStatus, number>
  );

  const seen = counts.visto + counts.repasado;
  const current = currentUnit(units);
  const next = nextUnit(units);
  const lastSeen = units
    .filter((unit) => unit.seenInClassAt)
    .sort((a, b) => new Date(b.seenInClassAt!).getTime() - new Date(a.seenInClassAt!).getTime())[0] ?? null;

  const pace = classPacePerWeek(units, now);
  const remaining = Math.max(0, units.length - seen - counts.en_curso);
  const weeksRemaining = pace && pace > 0 ? Math.round((remaining / pace) * 10) / 10 : null;
  const projected =
    weeksRemaining === null ? null : new Date(now.getTime() + weeksRemaining * 7 * DAY_MS).toISOString();

  return {
    total: units.length,
    counts,
    seen,
    progressPct: units.length === 0 ? 0 : Math.round((seen / units.length) * 100),
    currentUnitId: current?.id ?? null,
    nextUnitId: next?.id ?? null,
    lastSeenIso: lastSeen?.seenInClassAt ?? null,
    termNow: current?.term ?? next?.term ?? null,
    pacePerWeek: pace,
    weeksRemaining,
    projectedFinishIso: projected,
  };
}

interface RawTopic {
  id: string;
  subjectId: string;
  unitNumber: number | null;
  title: string;
  term: number | null;
  status: string;
  source: string;
  difficulty: number;
  masteryLevel: number;
  masterySource: string;
  seenInClassAt: Date | null;
  teacherMethod: string | null;
}

function toUnit(topic: RawTopic): TemarioUnit {
  return {
    id: topic.id,
    subjectId: topic.subjectId,
    unitNumber: topic.unitNumber,
    title: topic.title,
    term: topic.term,
    status: isTopicStatus(topic.status) ? topic.status : 'pendiente',
    source: topic.source,
    difficulty: topic.difficulty,
    masteryLevel: topic.masteryLevel,
    masterySource: topic.masterySource,
    seenInClassAt: topic.seenInClassAt ? topic.seenInClassAt.toISOString() : null,
    teacherMethod: topic.teacherMethod ?? null,
  };
}

/**
 * Lectura compartida del temario.
 *
 * El temario se consulta al abrir `/temario`, al calcular el chequeo de clase
 * del Cuartel y en varias acciones. Es la misma foto para todos esos sitios,
 * así que se cachea 20 s con la etiqueta `temario`. Las mutaciones de unidades
 * llaman a `revalidateTag('temario')`, de modo que un cambio se ve al instante
 * y no se paga una consulta completa en cada navegación.
 */
type TemarioSubjectBase = Omit<TemarioSubject, 'stats'>;

const loadTemarioBase = unstable_cache(
  async (): Promise<TemarioSubjectBase[]> => {
    const subjects = await prisma.subject.findMany({
      orderBy: [{ order: 'asc' }, { name: 'asc' }],
      include: { topics: true },
    });

    return subjects.map((subject) => ({
      id: subject.id,
      name: subject.name,
      color: subject.color,
      units: sortUnits(subject.topics.map(toUnit)),
    }));
  },
  ['temario-base-v1'],
  { revalidate: 20, tags: ['temario'] }
);

/** Todas las asignaturas con su temario, ordenado y con estadísticas. */
export async function getTemarioSubjects(now = new Date()): Promise<TemarioSubject[]> {
  const subjects = await loadTemarioBase();

  return subjects.map((subject) => ({
    ...subject,
    stats: computeStats(subject.units, now),
  }));
}

export interface CheckInItem {
  subjectId: string;
  subjectName: string;
  color: string;
  startTime: string;
  endTime: string;
  /** La unidad que el sistema cree que se ha explicado hoy. */
  suggested: TemarioUnit | null;
  /** Alternativas por si el profesor va por otro sitio. */
  candidates: TemarioUnit[];
  /** Unidad que ya tenías marcada como dada hoy en esa asignatura. */
  markedToday: TemarioUnit | null;
}

/**
 * Qué asignaturas has tenido hoy y qué unidad tocaría marcar en cada una.
 * Solo devuelve asignaturas cuya clase ya ha terminado (no interrumpe la mañana).
 */
export async function getTodayClassCheckIn(now = new Date()): Promise<CheckInItem[]> {
  const dayOfWeek = now.getDay();
  if (dayOfWeek < 1 || dayOfWeek > 5) return [];

  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const periods = await prisma.classPeriod.findMany({
    where: { dayOfWeek },
    orderBy: { startTime: 'asc' },
  });
  if (periods.length === 0) return [];

  const subjects = await getTemarioSubjects(now);
  const byId = new Map(subjects.map((subject) => [subject.id, subject]));

  const items: CheckInItem[] = [];
  const seenSubjects = new Set<string>();

  for (const period of periods) {
    // Una clase cuenta como «dada» cuando ya ha terminado.
    if (period.endTime > hhmm) continue;
    if (seenSubjects.has(period.subjectId)) continue;

    const subject = byId.get(period.subjectId);
    if (!subject) continue;
    seenSubjects.add(period.subjectId);

    const markedToday =
      [...subject.units]
        .reverse()
        .find(
          (unit) => unit.seenInClassAt && new Date(unit.seenInClassAt).getTime() >= todayStart.getTime()
        ) ?? null;

    const pending = sortUnits(subject.units).filter((unit) => unit.status === 'pendiente');
    const suggested = nextUnit(subject.units);
    const candidates = pending.slice(0, 8);

    items.push({
      subjectId: subject.id,
      subjectName: subject.name,
      color: subject.color,
      startTime: period.startTime,
      endTime: period.endTime,
      suggested,
      candidates: candidates.length > 0 ? candidates : subject.units.slice(0, 8),
      markedToday,
    });
  }

  return items;
}

/** Unidades de hoy resumidas para el Cuartel: qué toca dar en cada asignatura. */
export async function getCurrentUnitBySubject(now = new Date()): Promise<
  Map<string, { current: TemarioUnit | null; next: TemarioUnit | null; total: number; seen: number }>
> {
  const subjects = await getTemarioSubjects(now);
  const map = new Map<
    string,
    { current: TemarioUnit | null; next: TemarioUnit | null; total: number; seen: number }
  >();
  for (const subject of subjects) {
    map.set(subject.id, {
      current: currentUnit(subject.units),
      next: nextUnit(subject.units),
      total: subject.units.length,
      seen: subject.stats.seen,
    });
  }
  return map;
}

/**
 * Obtiene el estado actual del temario para su uso en el planificador.
 * Devuelve las asignaturas con sus unidades y estados de progreso.
 */
export async function fetchTemarioState(now = new Date()) {
  const subjects = await getTemarioSubjects(now);
  return { subjects };
}
