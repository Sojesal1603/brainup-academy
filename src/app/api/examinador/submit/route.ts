import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import {
  gradeWithRubric,
  type BlockResult,
  type ExamBlock,
} from '@/lib/examinador';
import { auditEbauErrors, gradeEbauWithRubric } from '@/lib/ebauSimulator';
import { readUploadText } from '@/lib/docStore';
import type { ExamGrade, ExamPackage } from '@/lib/examenTypes';

export const dynamic = 'force-dynamic';

interface SubmitBody {
  sessionId?: unknown;
  answers?: unknown;
  elapsedMinutes?: unknown;
  selfScores?: unknown;
  /** Resoluciones escaneadas o PDFs subidos antes de corregir. */
  uploadIds?: unknown;
}

function clampNumber(value: unknown, min: number, max: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return min;
  return Math.min(max, Math.max(min, num));
}

function round4(value: number): number {
  return Math.round(value * 4) / 4; // cuartos de punto, como la corrección real
}

/**
 * Ajusta el dominio de los temas tras la corrección: lo corregido en falso
 * baja (hay que volver a machacarlo) y lo clavado sube ligeramente.
 * Nunca bloquea la respuesta si falla.
 */
async function adjustMastery(
  userId: string,
  blocks: ExamBlock[],
  results: BlockResult[]
): Promise<string[]> {
  const prisma = db(userId);
  const notes: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const result = results[i];
    if (!block?.topicId || !result) continue;

    const ratio = result.max > 0 ? result.score / result.max : 0;

    try {
      if (ratio < 0.5) {
        const topic = await prisma.topic.findFirst({ where: { id: block.topicId } });
        if (topic) {
          await prisma.topic.update({
            where: { id: block.topicId },
            data: {
              masteryLevel: Math.max(0, topic.masteryLevel - 5),
              masterySource: 'simulacro',
            },
          });
          notes.push(`«${block.topicTitle}»: dominio bajado 5% (fallado en simulacro)`);
        }
      } else if (ratio >= 0.85) {
        const topic = await prisma.topic.findFirst({ where: { id: block.topicId } });
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
 * Corrige un simulacro EBAU.
 *
 * Acepta la resolución escrita y los documentos adjuntos (`uploadIds`). La
 * corrección devuelve nota, desglose por apartados y fallos de notación; los
 * bloques flojos se auditan contra el Banco de Errores y el planificador.
 */
export async function POST(request: NextRequest) {
  const user = await requireUser();
  const prisma = db(user.id);
  const body = (await request.json().catch(() => null)) as SubmitBody | null;
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
  if (!sessionId) {
    return NextResponse.json({ error: 'Falta el identificador de la sesión.' }, { status: 400 });
  }

  const session = await prisma.pauExamSession.findFirst({ where: { id: sessionId } });
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

  // Resolución adjunta: se lee el texto extraído al subirla y se cruza con los
  // bloques. Un PDF escaneado sin texto no se inventa: se ignora y se corrige
  // lo que el alumno haya escrito.
  const rawUploadIds = Array.isArray(body?.uploadIds) ? (body!.uploadIds as unknown[]) : [];
  const uploadIds = rawUploadIds
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
    .slice(0, 4);

  const uploadedTexts: string[] = [];
  for (const id of uploadIds) {
    const text = await readUploadText(id).catch(() => null);
    if (text) uploadedTexts.push(text.slice(0, 12_000));
  }
  if (uploadedTexts.length > 0) {
    const combined = uploadedTexts.join('\n\n---\n\n').slice(0, 30_000);
    const base = answers[0]?.trim() ? `${answers[0]}\n\n` : '';
    answers[0] = `${base}RESOLUCIÓN ADJUNTA (puede cubrir varios bloques):\n${combined}`;
  }

  const elapsedMinutes = Math.round(
    clampNumber(body?.elapsedMinutes, 0, session.timedMinutes * 2)
  );

  // Autoevaluación guiada: el alumno puntúa cada bloque.
  const rawSelf = Array.isArray(body?.selfScores) ? (body!.selfScores as unknown[]) : null;
  const hasSelf = rawSelf !== null && rawSelf.some((value) => Number(value) > 0);

  let grade: ExamGrade | null = null;

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
      community: session.community ?? pkg.community,
    };
  } else {
    const useEbau = Boolean(session.community ?? pkg.community);
    grade = useEbau
      ? await gradeEbauWithRubric({
          subjectName: session.subjectName,
          communityCode: session.community ?? pkg.community,
          blocks,
          answers,
        })
      : await gradeWithRubric({
          subjectName: session.subjectName,
          blocks,
          answers,
        });

    if (!grade) {
      return NextResponse.json({
        ok: false,
        mode: 'self',
        message:
          'La corrección con IA no está disponible ahora mismo (sin clave o cupo agotado). Pasa a autoevaluación guiada: puntúa con honestidad cada bloque.',
      });
    }
  }

  // Auditoría: errores al banco y píldoras al plan de hoy.
  const subjectId =
    session.subjectId ??
    (
      await prisma.subject.findFirst({
        where: { name: session.subjectName },
        select: { id: true },
      })
    )?.id ??
    null;

  let auditNote = '';
  if (subjectId) {
    try {
      const audit = await auditEbauErrors(user.id, {
        sessionId: session.id,
        subjectId,
        subjectName: session.subjectName,
        community: session.community ?? pkg.community ?? 'ebaU',
        blocks,
        results: grade.blocks,
      });
      grade.audit = audit;
      if (audit.errorsCreated > 0 || audit.pillsCreated > 0) {
        auditNote = `\n\nAuditoría: ${audit.errorsCreated} ficha(s) nueva(s) en el Banco de Errores y ${audit.pillsCreated} píldora(s) de repaso en el plan de hoy.`;
      }
    } catch (error) {
      console.error('[examinador] no se pudo auditar el simulacro:', error);
    }
  }

  const masteryNotes = await adjustMastery(user.id, blocks, grade.blocks);
  const feedback = [grade.globalFeedback, masteryNotes.join('\n'), auditNote]
    .filter((part) => part.trim().length > 0)
    .join('\n\n');

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
