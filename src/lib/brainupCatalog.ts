import { unstable_cache } from 'next/cache';
import { db } from './db';

/**
 * Catálogo del hub de catedráticos (`/brainup`).
 *
 * Es la consulta más pesada de esa vista: todas las materias con sus errores
 * abiertos, el estado de sus unidades y el próximo examen. La tarjeta solo
 * necesita contadores y una fecha, así que se materializa una foto serializable
 * de 30 s. Las acciones de temario y exámenes purgan `temario`/`catalogo`.
 */
export interface BrainUpCatalogAgent {
  id: string;
  name: string;
  specialty: string;
  subject: {
    id: string;
    name: string;
    color: string;
    unmasteredErrors: number;
    inCourse: boolean;
    nextExam: { title: string; examDateIso: string } | null;
  };
}

const loadBrainUpCatalog = unstable_cache(
  async (userId: string): Promise<BrainUpCatalogAgent[]> => {
    const agents = await db(userId).aiAgent.findMany({
      include: {
        subject: {
          include: {
            errorLogs: { where: { isMastered: false }, select: { id: true } },
            topics: { select: { status: true }, take: 200 },
            exams: {
              where: { isCompleted: false, examDate: { gte: new Date() } },
              orderBy: { examDate: 'asc' },
              take: 1,
              select: { title: true, examDate: true },
            },
          },
        },
      },
      orderBy: { subject: { order: 'asc' } },
    });

    return agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      specialty: agent.specialty,
      subject: {
        id: agent.subject.id,
        name: agent.subject.name,
        color: agent.subject.color,
        unmasteredErrors: agent.subject.errorLogs.length,
        inCourse: agent.subject.topics.some((topic) => topic.status === 'en_curso'),
        nextExam: agent.subject.exams[0]
          ? {
              title: agent.subject.exams[0].title,
              examDateIso: agent.subject.exams[0].examDate.toISOString(),
            }
          : null,
      },
    }));
  },
  ['brainup-catalog-v1'],
  { revalidate: 30, tags: ['brainup', 'catalogo', 'temario'] }
);

export function getBrainUpCatalog(userId: string): Promise<BrainUpCatalogAgent[]> {
  return loadBrainUpCatalog(userId);
}
