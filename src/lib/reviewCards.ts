/**
 * Persistencia de las tarjetas de repaso espaciado.
 *
 * Las herramientas de estudio (flashcards y tests) se generan en el servidor;
 * aquí se guardan como `ReviewCard` para que tengan historial SM-2 propio. La
 * clave es `[userId, topicId, front]`: regenerar las mismas tarjetas no borra
 * lo que ya sabías de ellas, solo actualiza el reverso y la fuente.
 */

import { db } from './db';
import type {
  Flashcard,
  FlashcardsTool,
  QuizQuestion,
  StudyToolPayload,
  TestTool,
} from './studyTools';

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeFront(front: string): string {
  return front.replace(/\s+/g, ' ').trim().slice(0, 500);
}

function normalizeBack(back: string): string {
  return back.trim().slice(0, 2_000);
}

interface CardSeed {
  front: string;
  back: string;
  source: string | null;
}

async function upsertCard(
  userId: string,
  topicId: string,
  kind: string,
  seed: CardSeed
): Promise<{ id: string; front: string }> {
  const prisma = db(userId);
  const front = normalizeFront(seed.front);
  const back = normalizeBack(seed.back);

  const row = await prisma.reviewCard.upsert({
    where: {
      userId_topicId_front: {
        userId,
        topicId,
        front,
      },
    },
    create: {
      topicId,
      kind,
      front,
      back,
      source: seed.source,
      dueAt: new Date(),
    },
    update: {
      kind,
      back,
      source: seed.source,
    },
    select: { id: true, front: true },
  });

  return row;
}

/**
 * Guarda las flashcards o preguntas de test generadas y devuelve la herramienta
 * con `cardId` en cada elemento. El cliente solo puede valorar lo que existe en
 * la base: nada de ids inventados desde el navegador.
 */
export async function registerStudyToolCards(input: {
  userId: string;
  topicId: string;
  tool: StudyToolPayload;
}): Promise<StudyToolPayload> {
  const { userId, topicId, tool } = input;

  if (tool.kind === 'flashcards') {
    const cards: Flashcard[] = [];
    for (const card of tool.cards) {
      const row = await upsertCard(userId, topicId, 'flashcard', card);
      cards.push({ ...card, cardId: row.id });
    }
    const next: FlashcardsTool = { ...tool, cards };
    return next;
  }

  if (tool.kind === 'test') {
    const questions: QuizQuestion[] = [];
    for (const question of tool.questions) {
      const correct = asText(question.options[question.correctIndex]);
      const row = await upsertCard(userId, topicId, 'test', {
        front: question.question,
        back: `${correct} — ${question.explanation}`,
        source: question.source,
      });
      questions.push({ ...question, cardId: row.id });
    }
    const next: TestTool = { ...tool, questions };
    return next;
  }

  return tool;
}

/** Tarjetas vencidas agrupadas por unidad, para inyectarlas en el plan. */
export async function dueReviewCardsByTopic(
  userId: string,
  now: Date = new Date()
): Promise<Array<{ topicId: string; count: number }>> {
  const prisma = db(userId);
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);

  const groups = await prisma.reviewCard.groupBy({
    by: ['topicId'],
    where: { dueAt: { lte: endOfDay } },
    _count: { _all: true },
  });

  return groups
    .map((group) => ({ topicId: group.topicId, count: group._count._all }))
    .sort((a, b) => b.count - a.count);
}

/** Suma segundos de consulta al catedrático a una sesión de Focus activa. */
export async function incrementTutorSeconds(
  userId: string,
  sessionId: string,
  seconds: number
): Promise<void> {
  const prisma = db(userId);
  const safe = Math.min(120, Math.max(1, Math.round(seconds)));
  await prisma.focusSession.updateMany({
    where: {
      id: sessionId,
      status: { in: ['running', 'paused'] },
    },
    data: { tutorSeconds: { increment: safe } },
  });
}
