/**
 * Cierre de la sesión con el catedrático.
 *
 * El alumno confirma el cierre; el servidor escribe una sola vez lo que la
 * sesión deja: fichas en el Banco de Errores, tarjetas de repaso y el resultado
 * de la sesión (`TutorSessionOutcome`), y marca el plan para recalcular.
 *
 * La operación es idempotente por `sessionKey`: el índice único
 * `[userId, sessionKey]` hace que un doble clic o un reintento de red no
 * dupliquen ni las fichas ni las tarjetas. El resultado va entero en una
 * transacción: o queda todo, o no queda nada que reintentar.
 */

import { z } from 'zod';
import { db } from './db';
import { frontHash } from './frontHash';
import { invalidatePlan } from './planner/state';
import { prismaErrorCode } from './databaseDiagnostics';
import { ROOT_CAUSES } from './sessionCloseTypes';

export { ROOT_CAUSES, ROOT_CAUSE_LABELS } from './sessionCloseTypes';
export type { RootCause } from './sessionCloseTypes';

export const sessionErrorSchema = z.object({
  questionPrompt: z.string().trim().min(3).max(2_000),
  myAnswer: z.string().trim().max(4_000).default(''),
  correctAnswer: z.string().trim().min(1).max(4_000),
  rootCause: z.enum(ROOT_CAUSES),
  keyLesson: z.string().trim().min(3).max(600),
  correctiveAction: z.string().trim().min(3).max(600),
});

export const sessionCardSchema = z.object({
  front: z.string().trim().min(3).max(500),
  back: z.string().trim().min(1).max(2_000),
  kind: z.enum(['flashcard', 'test', 'concepto']).default('flashcard'),
});

export const closeSessionInputSchema = z.object({
  // Lo genera el cliente y no cambia entre reintentos (p. ej. `sesion:<id>`).
  sessionKey: z
    .string()
    .trim()
    .min(8)
    .max(200)
    .regex(/^[A-Za-z0-9:_-]+$/, 'sessionKey solo admite letras, números, «:», «_» y «-»'),
  planId: z.string().trim().min(1).max(64).nullish(),
  subjectId: z.string().trim().min(1).max(64).nullish(),
  topicId: z.string().trim().min(1).max(64),
  // Qué se trabajó y qué quedó pendiente, en frases cortas.
  workedOn: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  pending: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  errors: z.array(sessionErrorSchema).max(20).default([]),
  cards: z.array(sessionCardSchema).max(20).default([]),
  directSolutionCount: z.number().int().min(0).max(500).default(0),
  endedAt: z.coerce.date().optional(),
});

export type CloseSessionInput = z.input<typeof closeSessionInputSchema>;

export interface CloseSessionResult {
  sessionKey: string;
  outcomeId: string;
  alreadyClosed: boolean;
  errorsCreated: number;
  reviewCardsCreated: number;
  planInvalidated: boolean;
}

function asJson(items: string[]) {
  return { items };
}

/**
 * Cierra la sesión. Lanza un error claro si la entrada no valida: nunca guarda
 * «lo que se haya podido entender» de un fallo.
 */
export async function closeTutorSession(
  userId: string,
  raw: unknown
): Promise<CloseSessionResult> {
  const parsed = closeSessionInputSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(
      `Cierre de sesión inválido${first ? `: ${first.path.join('.')} — ${first.message}` : ''}`
    );
  }

  const input = parsed.data;
  const endedAt = input.endedAt ?? new Date();
  const prisma = db(userId);

  // Camino rápido (y silencioso) para el doble clic normal: si la clave ya
  // existe, no se intenta escribir ni se registra un error de índice único. La
  // transacción de abajo sigue siendo la que cubre la carrera de verdad.
  const already = await prisma.tutorSessionOutcome.findFirst({
    where: { sessionKey: input.sessionKey },
    select: { id: true, errorsCreated: true, reviewCardsCreated: true },
  });
  if (already) {
    return {
      sessionKey: input.sessionKey,
      outcomeId: already.id,
      alreadyClosed: true,
      errorsCreated: already.errorsCreated,
      reviewCardsCreated: already.reviewCardsCreated,
      planInvalidated: false,
    };
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const topic = await tx.topic.findFirst({
        where: { id: input.topicId },
        select: { id: true, subjectId: true, title: true },
      });
      if (!topic) throw new Error('El tema de la sesión no existe');

      const subjectId = input.subjectId ?? topic.subjectId;

      const outcome = await tx.tutorSessionOutcome.create({
        data: {
          userId,
          sessionKey: input.sessionKey,
          planId: input.planId ?? null,
          subjectId,
          topicId: topic.id,
          // El primer paso es el que impide duplicar: si la clave ya existe, el
          // índice único aborta la transacción entera.
          workedOn: asJson(input.workedOn),
          pending: asJson(input.pending),
          nextPlan: asJson(input.pending),
          directSolutionCount: input.directSolutionCount,
          startedAt: endedAt,
          endedAt,
        },
      });

      let errorsCreated = 0;
      for (const error of input.errors) {
        await tx.errorLog.create({
          data: {
            subjectId,
            topicId: topic.id,
            questionPrompt: error.questionPrompt,
            myAnswer: error.myAnswer,
            correctAnswer: error.correctAnswer,
            rootCause: error.rootCause,
            keyLesson: error.keyLesson,
            correctiveAction: error.correctiveAction,
          },
        });
        errorsCreated += 1;
      }

      let reviewCardsCreated = 0;
      for (const card of input.cards) {
        const hash = frontHash(card.front);
        const existing = await tx.reviewCard.findFirst({
          where: { topicId: topic.id, OR: [{ front: card.front }, { frontHash: hash }] },
          select: { id: true },
        });

        await tx.reviewCard.upsert({
          where: {
            userId_topicId_front: { userId, topicId: topic.id, front: card.front },
          },
          create: {
            topicId: topic.id,
            kind: card.kind,
            front: card.front,
            frontHash: hash,
            back: card.back,
            source: 'cierre de sesión con el catedrático',
          },
          update: {
            back: card.back,
            frontHash: hash,
            source: 'cierre de sesión con el catedrático',
          },
        });
        if (!existing) reviewCardsCreated += 1;
      }

      await tx.tutorSessionOutcome.update({
        where: { id: outcome.id },
        data: { errorsCreated, reviewCardsCreated },
      });

      return { outcomeId: outcome.id, errorsCreated, reviewCardsCreated };
    });

    // Fuera de la transacción: si falla el plan, el cierre ya está guardado y no
    // se pierde. Se avisa en el resultado.
    let planInvalidated = true;
    try {
      await invalidatePlan(userId, 'cierre de sesión con el catedrático');
    } catch (error) {
      planInvalidated = false;
      console.warn('[sessionClose] no se pudo invalidar el plan:', error);
    }

    return {
      sessionKey: input.sessionKey,
      ...result,
      alreadyClosed: false,
      planInvalidated,
    };
  } catch (error) {
    if (prismaErrorCode(error) !== 'P2002') throw error;

    // Ya estaba cerrada: se devuelve lo que hay, sin volver a escribir nada.
    const existing = await prisma.tutorSessionOutcome.findFirst({
      where: { sessionKey: input.sessionKey },
      select: { id: true, errorsCreated: true, reviewCardsCreated: true },
    });
    if (!existing) throw error;

    return {
      sessionKey: input.sessionKey,
      outcomeId: existing.id,
      alreadyClosed: true,
      errorsCreated: existing.errorsCreated,
      reviewCardsCreated: existing.reviewCardsCreated,
      planInvalidated: false,
    };
  }
}
