import nextDynamic from 'next/dynamic';
import { currentTenant } from '@/lib/tenantContext';
import { getNotesWorkspace } from '@/lib/notesWorkspace';
import MoodleMaterialsPanel from '@/components/apuntes/MoodleMaterialsPanel';
import { EditorSkeleton } from '@/components/ui/Skeletons';
import { BookOpen } from 'lucide-react';

// El cuaderno es un editor completo (~900 líneas y las acciones que usa): su
// código baja al entrar aquí, y mientras llega se ve su forma ya dibujada.
const NotionWorkspace = nextDynamic(() => import('@/components/apuntes/NotionWorkspace'), {
  loading: () => <EditorSkeleton />,
});

export default async function NotesPage() {
  const { user } = await currentTenant();
  // La unidad y la asignatura dan la sección del cuaderno; el agente dice qué
  // catedrático lo ha escrito. La foto está cacheada y las acciones de apuntes
  // purgan la etiqueta `apuntes`.
  const { notes, subjects, materials } = await getNotesWorkspace(user.id);

  return (
    <div className="space-y-8">
      {/* Cabecera */}
      <div className="pb-4 border-b border-white/10">
        <div className="flex items-center gap-2">
          <BookOpen className="w-6 h-6 shrink-0 text-emerald-400" />
          <h1 className="text-xl sm:text-2xl leading-tight font-black tracking-tight text-slate-100 uppercase font-mono">
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
      <MoodleMaterialsPanel materials={materials} />

      {/* Workspace Interactivo */}
      <NotionWorkspace
        notes={notes.map((note) => ({ ...note, updatedAt: note.updatedAtIso }))}
        subjects={subjects}
      />
    </div>
  );
}
