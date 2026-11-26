import { unstable_cache } from 'next/cache';
import { db } from './db';

/**
 * Lectura compartida del cuaderno de apuntes.
 *
 * `/apuntes` es una de las pantallas más pesadas de la app: trae todos los
 * apuntes con su unidad y asignatura, el catálogo de materias y hasta 400
 * materiales de Moodle. Ninguno de esos datos cambia entre dos clics seguidos,
 * así que se materializa una foto de 30 s con etiqueta `apuntes`. Las acciones
 * que crean, editan o borran apuntes la purgan al instante.
 *
 * Las fechas se guardan como ISO porque `unstable_cache` serializa a JSON; el
 * editor ya las normaliza con `new Date(...)` al pintarlas.
 */
export interface NotesWorkspaceNote {
  id: string;
  topicId: string;
  title: string;
  content: string;
  tags: string | null;
  updatedAtIso: string;
  author: string;
  agent: { name: string } | null;
  topic: {
    id: string;
    title: string;
    unitNumber: number | null;
    subject: { id: string; name: string; color: string };
  };
}

export interface NotesWorkspaceSubject {
  id: string;
  name: string;
  color: string;
  topics: Array<{ id: string; title: string }>;
}

export interface NotesWorkspaceMaterial {
  id: string;
  name: string;
  sectionName: string;
  courseName: string;
  moduleType: string;
  mimeType: string | null;
  sizeBytes: number;
  modifiedAtIso: string | null;
  hasFile: boolean;
  webUrl: string | null;
  downloaded: boolean;
}

export interface NotesWorkspaceData {
  notes: NotesWorkspaceNote[];
  subjects: NotesWorkspaceSubject[];
  materials: NotesWorkspaceMaterial[];
}

const loadNotesWorkspace = unstable_cache(
  async (userId: string): Promise<NotesWorkspaceData> => {
    const prisma = db(userId);

    const [notes, subjects, materials] = await Promise.all([
      prisma.note.findMany({
        include: {
          topic: { include: { subject: true } },
          agent: { select: { name: true } },
        },
        orderBy: { updatedAt: 'desc' },
      }),
      prisma.subject.findMany({
        include: { topics: { select: { id: true, title: true } } },
        orderBy: { order: 'asc' },
      }),
      prisma.moodleMaterial.findMany({
        include: { course: { select: { fullName: true, shortName: true } } },
        orderBy: [{ course: { fullName: 'asc' } }, { sectionName: 'asc' }, { name: 'asc' }],
        take: 400,
      }),
    ]);

    return {
      notes: notes.map((note) => ({
        id: note.id,
        topicId: note.topicId,
        title: note.title,
        content: note.content,
        tags: note.tags,
        updatedAtIso: note.updatedAt.toISOString(),
        author: note.author,
        agent: note.agent,
        topic: {
          id: note.topic.id,
          title: note.topic.title,
          unitNumber: note.topic.unitNumber,
          subject: {
            id: note.topic.subject.id,
            name: note.topic.subject.name,
            color: note.topic.subject.color,
          },
        },
      })),
      subjects: subjects.map((subject) => ({
        id: subject.id,
        name: subject.name,
        color: subject.color,
        topics: subject.topics.map((topic) => ({ id: topic.id, title: topic.title })),
      })),
      materials: materials.map((material) => ({
        id: material.id,
        name: material.name,
        sectionName: material.sectionName ?? '',
        courseName: material.course.fullName || material.course.shortName,
        moduleType: material.moduleType,
        mimeType: material.mimeType,
        sizeBytes: material.sizeBytes ?? 0,
        modifiedAtIso: material.modifiedAt ? material.modifiedAt.toISOString() : null,
        hasFile: Boolean(material.downloadUrl),
        webUrl: material.webUrl,
        downloaded: Boolean(material.localPath),
      })),
    };
  },
  ['notes-workspace-v1'],
  { revalidate: 30, tags: ['apuntes', 'notas', 'moodle'] }
);

export function getNotesWorkspace(userId: string): Promise<NotesWorkspaceData> {
  return loadNotesWorkspace(userId);
}
