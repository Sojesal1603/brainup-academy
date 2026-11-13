import nextDynamic from 'next/dynamic';
import { currentTenant } from '@/lib/tenantContext';
import { PanelSkeleton } from '@/components/ui/Skeletons';

// El estudio (interfaz completa y render de apuntes) se descarga al abrir la
// sección, no con la navegación general.
const NotebookLmStudio = nextDynamic(() => import('@/components/notebooklm/NotebookLmStudio'), {
  loading: () => <PanelSkeleton lines={6} />,
});

export const dynamic = 'force-dynamic';

export default async function NotebookLmPage() {
  const { tenant: prisma } = await currentTenant();
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
