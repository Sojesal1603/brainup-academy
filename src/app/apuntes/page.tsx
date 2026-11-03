import { prisma } from '@/lib/prisma';
import NotionWorkspace from '@/components/apuntes/NotionWorkspace';
import MoodleMaterialsPanel from '@/components/apuntes/MoodleMaterialsPanel';
import { BookOpen } from 'lucide-react';

export const dynamic = 'force-dynamic';

export default async function NotesPage() {
  const notes = await prisma.note.findMany({
    include: {
      // La unidad y la asignatura dan la sección del cuaderno; el agente dice
      // qué catedrático lo ha escrito, si lo ha escrito uno.
      topic: {
        include: {
          subject: true,
        },
      },
      agent: { select: { name: true } },
    },
    orderBy: { updatedAt: 'desc' },
  });

  const subjects = await prisma.subject.findMany({
    include: {
      topics: {
        select: { id: true, title: true },
      },
    },
    orderBy: { order: 'asc' },
  });

  // Apuntes que el profesor ha subido a Moodle (vacíos si no está conectado).
  const moodleMaterials = await prisma.moodleMaterial.findMany({
    include: { course: { select: { fullName: true, shortName: true } } },
    orderBy: [{ course: { fullName: 'asc' } }, { sectionName: 'asc' }, { name: 'asc' }],
    take: 400,
  });

  return (
    <div className="space-y-8">
      {/* Cabecera */}
      <div className="pb-4 border-b border-white/10">
        <div className="flex items-center gap-2">
          <BookOpen className="w-6 h-6 text-emerald-400" />
          <h1 className="text-2xl font-black tracking-tight text-slate-100 uppercase font-mono">
            Cuaderno de Apuntes & Base de Datos Notion
          </h1>
        </div>
        <p className="text-xs text-slate-400 mt-1">
          Espacio integrado para redactar apuntes de 1º de Bachillerato, diseñar bloques de Active Recall, fórmulas y organizar tu temario.
        </p>
        <p className="text-xs text-slate-400 mt-1">
          Organizado <strong className="text-slate-300">por asignatura</strong>: cada materia tiene su
          apartado. Los apuntes que te escriban los catedráticos IA aparecen ahí marcados como{' '}
          <strong className="text-violet-300">suyos</strong> — nunca se mezclan con los tuyos sin
          decírtelo — y puedes descargarlos o imprimirlos.
        </p>
      </div>

      {/* Apuntes de Moodle: lo que sube el profesor, sin salir de aquí */}
      <MoodleMaterialsPanel
        materials={moodleMaterials.map((material) => ({
          id: material.id,
          name: material.name,
          sectionName: material.sectionName,
          courseName: material.course.fullName || material.course.shortName,
          moduleType: material.moduleType,
          mimeType: material.mimeType,
          sizeBytes: material.sizeBytes,
          modifiedAtIso: material.modifiedAt ? material.modifiedAt.toISOString() : null,
          hasFile: Boolean(material.downloadUrl),
          webUrl: material.webUrl,
          downloaded: Boolean(material.localPath),
        }))}
      />

      {/* Workspace Interactivo */}
      <NotionWorkspace notes={notes} subjects={subjects} />
    </div>
  );
}
