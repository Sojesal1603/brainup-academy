import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth';

export async function GET() {
  try {
    const user = await requireUser();
    const prisma = db(user.id);
    const backup = {
      exportDate: new Date().toISOString(),
      version: '1.0.0',
      user: await prisma.userProfile.findFirst(),
      subjects: await prisma.subject.findMany({
        include: {
          topics: {
            include: {
              errors: true,
              sessions: true,
            },
          },
          exams: true,
        },
      }),
      habits: await prisma.habit.findMany({
        include: { logs: true },
      }),
      recentSessions: await prisma.studySession.findMany(),
      allErrors: await prisma.errorLog.findMany(),
    };

    return new NextResponse(JSON.stringify(backup, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="brainup_backup_${new Date().toISOString().split('T')[0]}.json"`,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Error exportando base de datos' },
      { status: 500 }
    );
  }
}
