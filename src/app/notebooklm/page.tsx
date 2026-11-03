import { prisma } from '@/lib/prisma';
import NotebookLmStudio from '@/components/notebooklm/NotebookLmStudio';

export const dynamic = 'force-dynamic';

export default async function NotebookLmPage() {
  const subjects = await prisma.subject.findMany({
    where: { isTracked: true },
    orderBy: { order: 'asc' },
    select: {
      id: true,
      name: true,
      color: true,
      topics: {
        orderBy: { unitNumber: 'asc' },
        select: {
          id: true,
          title: true,
          unitNumber: true,
          status: true,
          teacherMethod: true,
        },
      },
    },
  });

  return <NotebookLmStudio subjects={subjects} />;
}
