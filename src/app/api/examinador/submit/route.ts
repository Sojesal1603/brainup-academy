import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import {
  ExamPackage,
  gradeWithRubric,
  type BlockResult,
  type ExamBlock,
} from '@/lib/examinador';

export const dynamic = 'force-dynamic';

interface SubmitBody {
  sessionId?: unknown;
  answers?: unknown;
  elapsedMinutes?: unknown;
  selfScores?: unknown;
}

function clampNumber(value: unknown, min: number, max: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return min;
  return Math.min(max, Math.max(min, num));
}

function round4(value: number): number {
  return Math.round(value * 4) / 4; // cuartos de punto, como la corrección PAU real
}

/**
 * Ajusta el dominio de los temas tras la corrección: lo corregido en falso
 * baja (hay que volver a machacarlo) y lo clavado sube ligeramente.
 * Nunca bloquea la respuesta si falla.
 */
async function adjustMastery(blocks: ExamBlock[], results: BlockResult[]): Promise<string[]> {
  const notes: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const result = results[i];
    if (!block?.topicId || !result) continue;

    const ratio = result.max > 0 ? result.score / result.max : 0;

    try {
      if (ratio < 0.5) {
        const topic = await prisma.topic.findUnique({ where: { id: block.topicId } });
        if (topic) {
          await prisma.topic.update({
            where: { id: block.topicId },
            data: {
              masteryLevel: Math.max(0, topic.masteryLevel - 5),
              masterySource: 'simulacro', // a partir de aquí el nivel es medido, no supuesto
            },
          });
          notes.push(`«${block.topicTitle}»: dominio bajado 5% (fallado en simulacro)`);
        }
      } else if (ratio >= 0.85) {
        const topic = await prisma.topic.findUnique({ where: { id: block.topicId } });
        if (topic) {
          await prisma.topic.update({
            where: { id: block.topicId },
            data: {
              masteryLevel: Math.min(100, topic.masteryLevel + 3),
              masterySource: 'simulacro',
            },
          });
          notes.push(`«${block.topicTitle}»: dominio subido 3% (clavado en simulacro)`);
        }
      } else {
        // Aprobado sin sobresalir: sigue sin ser una medición fuerte, pero
        // dejamos constancia de que este tema ya se ha puesto a prueba.
        await prisma.topic.update({
          where: { id: block.topicId },
          data: { masterySource: 'simulacro' },
        });
      }
    } catch {
      // El ajuste de dominio es un extra: nunca debe tumbar la corrección.
    }
  }
  return notes;
}

/**
 * Corrige un simulacro. Con IA disponible usa rúbrica oficial; si no, responde
 * `mode: 'self'` para que el alumno complete la autoevaluación guiada.
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as SubmitBody | null;
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
  if (!sessionId) {
    return NextResponse.json({ error: 'Falta el identificador de la sesión.' }, { status: 400 });
  }

  const session = await prisma.pauExamSession.findUnique({ where: { id: sessionId } });
  if (!session) {
    return NextResponse.json({ error: 'Sesión de simulacro no encontrada.' }, { status: 404 });
  }

  // Sesión ya corregida: devolvemos el resultado guardado (idempotente).
  if (session.isCompleted && session.rubricFeedback) {
    return NextResponse.json({ ok: true, grade: JSON.parse(session.rubricFeedback) });
  }

  const pkg = session.questionsJson
    ? (JSON.parse(session.questionsJson) as ExamPackage)
    : { source: 'local' as const, blocks: [] };
  const blocks = pkg.blocks;

  if (blocks.length === 0) {
    return NextResponse.json({ error: 'La sesión no tiene bloques de examen.' }, { status: 400 });
  }

  const rawAnswers = Array.isArray(body?.answers) ? (body!.answers as unknown[]) : [];
  const answers = blocks.map((_, index) =>
    typeof rawAnswers[index] === 'string' ? (rawAnswers[index] as string).slice(0, 20000) : ''
  );

  const elapsedMinutes = Math.round(
    clampNumber(body?.elapsedMinutes, 0, session.timedMinutes * 2)
  );

  // Autoevaluación guiada: el alumno puntúa cada bloque (0 - 2,5).
  const rawSelf = Array.isArray(body?.selfScores) ? (body!.selfScores as unknown[]) : null;
  const hasSelf = rawSelf !== null && rawSelf.some((value) => Number(value) > 0);

  let grade: {
    mode: 'ai' | 'self';
    total: number;
    blocks: BlockResult[];
    weakTopicTitles: string[];
    globalFeedback: string;
    model?: string | null;
  } | null = null;

  if (hasSelf) {
    const results: BlockResult[] = blocks.map((block, index) => ({
      score: round4(clampNumber(rawSelf![index], 0, block.points)),
      max: block.points,
      feedback: 'Autoevaluación guiada (corrección IA no disponible en ese momento).',
    }));
    const total = Math.round(results.reduce((acc, r) => acc + r.score, 0) * 100) / 100;
    grade = {
      mode: 'self',
      total,
      blocks: results,
      weakTopicTitles: blocks
        .filter((_, i) => results[i].score < results[i].max * 0.6)
        .map((b) => b.topicTitle),
      globalFeedback: `Nota del simulacro (autoevaluación): ${total.toFixed(1)} / 10. Revisa los temas marcados como débiles: son los que reaparecerán en tu planificador.`,
    };
  } else {
    grade = await gradeWithRubric({ subjectName: session.subjectName, blocks, answers });
    if (!grade) {
      return NextResponse.json({
        ok: false,
        mode: 'self',
        message:
          'La corrección con IA no está disponible ahora mismo (sin clave de Gemini o cupo agotado). Pasa a autoevaluación guiada: puntúa con honestidad cada bloque del 0 al 2,5.',
      });
    }
  }

  const masteryNotes = await adjustMastery(blocks, grade.blocks);
  const feedback = masteryNotes.length > 0 ? `${grade.globalFeedback}\n\n${masteryNotes.join('\n')}` : grade.globalFeedback;

  await prisma.pauExamSession.update({
    where: { id: session.id },
    data: {
      answersJson: JSON.stringify(answers),
      elapsedMinutes,
      finalScore: grade.total,
      weakTopicsJson: JSON.stringify(grade.weakTopicTitles),
      rubricFeedback: JSON.stringify({ ...grade, globalFeedback: feedback }),
      isCompleted: true,
    },
  });

  return NextResponse.json({ ok: true, grade: { ...grade, globalFeedback: feedback } });
}
