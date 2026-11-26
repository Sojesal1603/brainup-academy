/**
 * Persistencia del coach.
 *
 * El perfil se guarda en `AgentMemory` (sin migración nueva) dentro del ámbito
 * `coach:<subjectId>`. La lectura va siempre por `db(userId)` y repite el
 * `userId` en el `where`: una cuenta no puede leer ni escribir el coach de otra.
 *
 * El refresco se lanza después de responder (en `after()`); el turno actual usa
 * el perfil que ya estuviera guardado y nunca espera a estas consultas.
 */
import { db } from '../db';
import { dayKeyInZone } from '../planner/state';
import {
  buildCoachProfile,
  coachProfileSchema,
  coachScope,
  COACH_SCOPE_PREFIX,
  type CoachProfile,
  type CoachInput,
} from './profile';

export const COACH_MAX_AGE_DAYS = 14;

function parseStoredProfile(raw: string | null, subjectId: string): CoachProfile | null {
  if (!raw) return null;
  try {
    const parsed = coachProfileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    if (parsed.data.subjectId !== subjectId) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

/**
 * Lee el último perfil del coach de esa materia. Caduca a los 14 días y nunca
 * lanza: el chat funciona igual sin coach.
 */
export async function loadCoachProfile(
  userId: string,
  subjectId: string,
  now: Date = new Date()
): Promise<CoachProfile | null> {
  try {
    const row = await db(userId).agentMemory.findFirst({
      where: { userId, scope: coachScope(subjectId) },
      orderBy: { createdAt: 'desc' },
      select: { factsJson: true, createdAt: true },
    });
    if (!row) return null;
    if (now.getTime() - row.createdAt.getTime() > COACH_MAX_AGE_DAYS * 86_400_000) return null;
    return parseStoredProfile(row.factsJson, subjectId);
  } catch {
    return null;
  }
}

/** Bloque compacto listo para `TutorContext.coach`. Vacío si no hay perfil. */
export async function loadCoachPromptBlock(
  userId: string,
  subjectId: string,
  now: Date = new Date()
): Promise<string> {
  const profile = await loadCoachProfile(userId, subjectId, now);
  return profile?.promptBlock.trim() ?? '';
}

/**
 * Recalcula el perfil desde observaciones reales y lo guarda para el siguiente
 * turno. Si no hay ninguna observación, no escribe nada: no se inventa un
 * diagnóstico con cero datos.
 */
export async function refreshCoachAdvice(
  userId: string,
  subjectId: string,
  options: { now?: Date; timezone?: string | null } = {}
): Promise<CoachProfile | null> {
  const now = options.now ?? new Date();
  const prisma = db(userId);
  const scope = coachScope(subjectId);
  if (scope === COACH_SCOPE_PREFIX) return null;

  const [
    subject,
    topics,
    totalTopics,
    measuredTopics,
    errors,
    blocks,
    focus,
    outcomes,
    errorsOpen,
    dueReviews,
  ] = await Promise.all([
    prisma.subject.findUnique({
      where: { id: subjectId },
      select: { id: true, name: true },
    }),
    prisma.topic.findMany({
      where: { subjectId },
      orderBy: [{ masteryLevel: 'asc' }, { title: 'asc' }],
      take: 80,
      select: { id: true, title: true, masteryLevel: true, masterySource: true },
    }),
    prisma.topic.count({ where: { subjectId } }),
    prisma.topic.count({ where: { subjectId, masterySource: { not: 'sin_medir' } } }),
    prisma.errorLog.findMany({
      where: { userId, subjectId },
      orderBy: { createdAt: 'desc' },
      take: 80,
      select: {
        rootCause: true,
        isMastered: true,
        reviewCount: true,
        topic: { select: { title: true } },
      },
    }),
    prisma.studyBlock.findMany({
      where: { userId, topic: { subjectId } },
      orderBy: { date: 'desc' },
      take: 50,
      select: {
        status: true,
        isCompleted: true,
        durationMinutes: true,
        spentMinutes: true,
      },
    }),
    prisma.focusSession.findMany({
      where: { userId, topic: { subjectId } },
      orderBy: { startedAt: 'desc' },
      take: 30,
      select: {
        status: true,
        plannedMinutes: true,
        focusedSeconds: true,
        pausedSeconds: true,
        tutorSeconds: true,
        interruptions: true,
      },
    }),
    prisma.tutorSessionOutcome.findMany({
      where: { userId, subjectId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        errorsCreated: true,
        directSolutionCount: true,
        reviewCardsCreated: true,
      },
    }),
    prisma.errorLog.count({ where: { userId, subjectId, isMastered: false } }),
    prisma.reviewCard.count({
      where: { userId, topic: { subjectId }, dueAt: { lte: now } },
    }),
  ]);

  if (!subject) return null;

  const input: CoachInput = {
    subjectId,
    subjectName: subject.name,
    generatedAtIso: now.toISOString(),
    errors: errors.map((error) => ({
      rootCause: error.rootCause,
      isMastered: error.isMastered,
      reviewCount: error.reviewCount,
      topicTitle: error.topic?.title,
    })),
    blocks: blocks.map((block) => ({
      status: block.status,
      isCompleted: block.isCompleted,
      durationMinutes: block.durationMinutes,
      spentMinutes: block.spentMinutes,
    })),
    focus: focus.map((session) => ({
      status: session.status,
      plannedMinutes: session.plannedMinutes,
      focusedSeconds: session.focusedSeconds,
      pausedSeconds: session.pausedSeconds,
      tutorSeconds: session.tutorSeconds,
      interruptions: session.interruptions,
    })),
    outcomes: outcomes.map((outcome) => ({
      errorsCreated: outcome.errorsCreated,
      directSolutionCount: outcome.directSolutionCount,
      reviewCardsCreated: outcome.reviewCardsCreated,
    })),
    topics: topics.map((topic) => ({
      id: topic.id,
      title: topic.title,
      mastery: topic.masteryLevel,
      measured: topic.masterySource !== 'sin_medir',
    })),
    state: {
      errorsOpen,
      dueReviews,
      units: { total: totalTopics, measured: measuredTopics },
    },
  };

  const profile = buildCoachProfile(input);
  if (profile.evidence.total === 0) return profile;

  const day = dayKeyInZone(now, options.timezone);
  await prisma.agentMemory.upsert({
    where: { userId_scope_day: { userId, scope, day } },
    create: {
      userId,
      scope,
      day,
      summary: profile.summary.slice(0, 1000),
      factsJson: JSON.stringify(profile),
      writtenBy: 'reglas',
    },
    update: {
      summary: profile.summary.slice(0, 1000),
      factsJson: JSON.stringify(profile),
      writtenBy: 'reglas',
    },
  });

  return profile;
}
