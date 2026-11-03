import { notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import PauExamRunner from '@/components/examen/PauExamRunner';
import ExamResults from '@/components/examen/ExamResults';
import type { ExamGrade, ExamPackage } from '@/lib/examenTypes';

export const dynamic = 'force-dynamic';

export default async function PauSessionPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;

  const session = await prisma.pauExamSession.findUnique({ where: { id: sessionId } });

  if (!session || !session.questionsJson) {
    notFound();
  }

  const pkg = JSON.parse(session.questionsJson) as ExamPackage;
  const answers = session.answersJson ? (JSON.parse(session.answersJson) as string[]) : [];
  const grade =
    session.isCompleted && session.rubricFeedback
      ? (JSON.parse(session.rubricFeedback) as ExamGrade)
      : null;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {grade ? (
        <ExamResults
          subjectName={session.subjectName}
          blocks={pkg.blocks}
          grade={grade}
          answers={answers}
          elapsedMinutes={session.elapsedMinutes}
        />
      ) : (
        <PauExamRunner
          sessionId={session.id}
          subjectName={session.subjectName}
          timedMinutes={session.timedMinutes}
          startedAtIso={session.createdAt.toISOString()}
          blocks={pkg.blocks}
          source={pkg.source}
          model={pkg.model ?? null}
          initialAnswers={answers}
        />
      )}
    </div>
  );
}
