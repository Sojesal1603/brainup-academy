'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  FileText,
  Plus,
  Trash2,
  Save,
  BookOpen,
  Sparkles,
  Play,
  Layers,
  Heading1,
  Heading2,
  List,
  CheckSquare,
  HelpCircle,
  Table,
  X,
  Tag,
  Eye,
  PenLine,
  Download,
  Printer,
} from 'lucide-react';
import {
  createNote,
  updateNote,
  deleteNote,
  createCustomSubject,
  createCustomTopic,
} from '@/lib/actions';
import NoteRenderer from './NoteRenderer';
import clsx from 'clsx';

/** Apunte tal y como llega del servidor, con quién lo ha escrito. */
export interface NotionNote {
  id: string;
  topicId: string;
  title: string;
  content: string;
  tags: string | null;
  updatedAt: Date;
  /** "alumno" (lo escribiste tú) o "catedratico" (lo escribió un catedrático IA). */
  author: string;
  /** El catedrático que lo escribió, si lo escribió uno. */
  agent: { name: string } | null;
  topic: {
    id: string;
    title: string;
    unitNumber: number | null;
    subject: {
      id: string;
      name: string;
      color: string;
    };
  };
}

interface NotionWorkspaceProps {
  notes: NotionNote[];
  subjects: Array<{
    id: string;
    name: string;
    color: string;
    topics: Array<{ id: string; title: string }>;
  }>;
}

/** ¿Este apunte lo ha escrito un catedrático IA o tú? */
export function isFromTutor(note: { author: string }): boolean {
  return note.author === 'catedratico';
}

/**
 * Distintivo de autoría: de un vistazo sabes si el apunte es tuyo o te lo ha
 * escrito un catedrático, y cuál.
 */
function AuthorBadge({
  author,
  agentName,
}: {
  author: string;
  agentName: string | null;
}) {
  if (isFromTutor({ author })) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded border border-violet-500/40 bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-bold text-violet-300"
        title={agentName ? `Escrito por ${agentName}` : 'Escrito por un catedrático IA'}
      >
        <Sparkles className="w-2.5 h-2.5 shrink-0" />
        <span className="max-w-[130px] truncate">{agentName || 'Catedrático'}</span>
      </span>
    );
  }

  return (
    <span
      className="inline-flex items-center gap-1 rounded border border-slate-600/60 bg-slate-700/20 px-1.5 py-0.5 text-[10px] font-bold text-slate-300"
      title="Escrito por ti"
    >
      <PenLine className="w-2.5 h-2.5 shrink-0" />
      <span>Tú</span>
    </span>
  );
}

export default function NotionWorkspace({ notes, subjects }: NotionWorkspaceProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [activeNoteId, setActiveNoteId] = useState<string | null>(
    notes[0]?.id || null
  );

  // Filtro por asignatura
  const [filterSubjectId, setFilterSubjectId] = useState<string>('all');
  // Filtro por autor: todo, solo lo que escribió un catedrático, o solo lo tuyo.
  const [filterAuthor, setFilterAuthor] = useState<'all' | 'catedratico' | 'alumno'>('all');

  // Estado del editor
  const activeNote = notes.find((n) => n.id === activeNoteId);
  const [title, setTitle] = useState(activeNote?.title || '');
  const [content, setContent] = useState(activeNote?.content || '');
  const [topicId, setTopicId] = useState(activeNote?.topicId || subjects[0]?.topics[0]?.id || '');
  const [tags, setTags] = useState(activeNote?.tags || '');
  const [saveStatus, setSaveStatus] = useState<string>('');
  const [viewMode, setViewMode] = useState<'view' | 'edit'>('view');

  // Modales
  const [isNewSubjectModalOpen, setIsNewSubjectModalOpen] = useState(false);
  const [isNewTopicModalOpen, setIsNewTopicModalOpen] = useState(false);
  const [newSubjectForm, setNewSubjectForm] = useState({
    name: '',
    color: '#3b82f6',
    isPhaseGeneral: false,
    pauWeight: 0.2,
  });
  const [newTopicForm, setNewTopicForm] = useState({
    subjectId: subjects[0]?.id || '',
    title: '',
    difficulty: 3,
  });

  // Cuando cambia la nota activa
  const handleSelectNote = (note: (typeof notes)[0]) => {
    setActiveNoteId(note.id);
    setTitle(note.title);
    setContent(note.content);
    setTopicId(note.topicId);
    setTags(note.tags || '');
    setSaveStatus('');
    setViewMode(note.content.trim() ? 'view' : 'edit');
  };

  // Crear nueva página de apuntes
  const handleCreateNewNote = () => {
    const firstTopic = subjects[0]?.topics[0];
    if (!firstTopic) return;

    startTransition(async () => {
      const res = await createNote({
        topicId: firstTopic.id,
        title: 'Nuevo Apunte de Estudio',
        content: `# 📝 Nuevo Apunte\n\n> **Objetivo:** Resume los puntos clave y añade preguntas de Active Recall.\n\n### 1. Concepto Fundamental\nEscribe aquí tu explicación...\n\n### 2. Autoevaluación Active Recall\n> **Pregunta:** ¿Cuál es la idea central?\n> *Respuesta:* ...`,
        tags: 'apuntes',
      });
      if (res.success && res.noteId) {
        setActiveNoteId(res.noteId);
        setTitle('Nuevo Apunte de Estudio');
        setViewMode('edit');
        setContent(
          `# 📝 Nuevo Apunte\n\n> **Objetivo:** Resume los puntos clave y añade preguntas de Active Recall.\n\n### 1. Concepto Fundamental\nEscribe aquí tu explicación...\n\n### 2. Autoevaluación Active Recall\n> **Pregunta:** ¿Cuál es la idea central?\n> *Respuesta:* ...`
        );
        router.refresh();
      }
    });
  };

  // Guardar cambios
  const handleSave = () => {
    if (!activeNoteId) return;
    startTransition(async () => {
      await updateNote({
        id: activeNoteId,
        title,
        content,
        tags,
      });
      setSaveStatus('Guardado ✓');
      setTimeout(() => setSaveStatus(''), 2000);
      router.refresh();
    });
  };

  // Borrar nota
  const handleDeleteNote = (id: string) => {
    if (!confirm('¿Seguro que deseas eliminar este apunte?')) return;
    startTransition(async () => {
      await deleteNote(id);
      setActiveNoteId(null);
      router.refresh();
    });
  };

  // Insertar snippets rápidos de Notion
  const insertSnippet = (snippet: string) => {
    setContent((prev) => prev + '\n\n' + snippet);
  };

  // Guardar nueva asignatura
  const handleSaveSubject = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSubjectForm.name) return;
    startTransition(async () => {
      await createCustomSubject(newSubjectForm);
      setIsNewSubjectModalOpen(false);
      setNewSubjectForm({
        name: '',
        color: '#3b82f6',
        isPhaseGeneral: false,
        pauWeight: 0.2,
      });
      router.refresh();
    });
  };

  // Guardar nuevo tema
  const handleSaveTopic = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTopicForm.title) return;
    startTransition(async () => {
      await createCustomTopic(newTopicForm);
      setIsNewTopicModalOpen(false);
      setNewTopicForm({
        subjectId: subjects[0]?.id || '',
        title: '',
        difficulty: 3,
      });
      router.refresh();
    });
  };

  // Filtrado de notas: asignatura + autor se combinan.
  const filteredNotes = notes.filter((n) => {
    if (filterSubjectId !== 'all' && n.topic.subject.id !== filterSubjectId) return false;
    if (filterAuthor === 'all') return true;
    return filterAuthor === 'catedratico' ? isFromTutor(n) : !isFromTutor(n);
  });

  const tutorNotes = notes.filter(isFromTutor).length;
  const ownNotes = notes.length - tutorNotes;

  /**
   * Una sección por asignatura (el «apartado» de cada materia) y, dentro, sus
   * apuntes ordenados por número de unidad para que el cuaderno se lea como el
   * temario.
   */
  const sections = useMemo(() => {
    const bySubject = new Map<
      string,
      { id: string; name: string; color: string; notes: NotionNote[] }
    >();

    for (const note of filteredNotes) {
      const subject = note.topic.subject;
      const section = bySubject.get(subject.id) ?? {
        id: subject.id,
        name: subject.name,
        color: subject.color,
        notes: [],
      };
      section.notes.push(note);
      bySubject.set(subject.id, section);
    }

    const list = [...bySubject.values()];
    list.sort((a, b) => a.name.localeCompare(b.name, 'es'));
    for (const section of list) {
      section.notes.sort((a, b) => {
        const unitA = a.topic.unitNumber ?? Number.MAX_SAFE_INTEGER;
        const unitB = b.topic.unitNumber ?? Number.MAX_SAFE_INTEGER;
        if (unitA !== unitB) return unitA - unitB;
        return a.title.localeCompare(b.title, 'es');
      });
    }
    return list;
  }, [filteredNotes]);

  /** Tarjeta de un apunte en la lista, con su distintivo de autoría. */
  const renderNoteCard = (note: NotionNote) => {
    const isSelected = note.id === activeNoteId;
    return (
      <div
        key={note.id}
        onClick={() => handleSelectNote(note)}
        className={clsx(
          'group p-3 rounded-xl border cursor-pointer transition-all space-y-1.5',
          isSelected
            ? 'bg-[#121c2e] border-emerald-500/40 shadow-sm'
            : 'bg-[#080d17] border-slate-800/80 hover:border-slate-700'
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <span
            className="text-[10px] font-bold px-1.5 py-0.5 rounded border shrink-0"
            style={{
              backgroundColor: `${note.topic.subject.color}15`,
              borderColor: `${note.topic.subject.color}40`,
              color: note.topic.subject.color,
            }}
          >
            {note.topic.subject.name}
          </span>
          <AuthorBadge author={note.author} agentName={note.agent?.name ?? null} />
        </div>

        <h4
          className={clsx(
            'text-xs font-bold truncate',
            isSelected ? 'text-emerald-300' : 'text-slate-200'
          )}
        >
          {note.title}
        </h4>

        <p className="text-[11px] text-slate-400 truncate">
          {note.topic.unitNumber ? `U${note.topic.unitNumber} · ` : ''}
          {note.topic.title}
        </p>

        <div className="flex items-center justify-between pt-1 text-[10px] text-slate-500 border-t border-slate-800/50">
          <span className="font-mono truncate">{note.tags || 'apuntes'}</span>
          <div className="flex items-center gap-1 shrink-0">
            <span className="font-mono text-slate-600">
              {new Date(note.updatedAt).toLocaleDateString('es-ES', {
                day: 'numeric',
                month: 'short',
              })}
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleDeleteNote(note.id);
              }}
              className="opacity-0 group-hover:opacity-100 text-slate-500 hover:text-rose-400 transition-opacity p-0.5"
              title="Eliminar apunte"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {/* Barra de Acciones y Gestión de Temario */}
      <div className="flex flex-wrap items-center justify-between gap-3 p-4 rounded-2xl bg-[#0b101d] border border-white/10">
        {/* Filtro por Asignatura */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider mr-1">
            Asignatura:
          </span>
          <button
            onClick={() => setFilterSubjectId('all')}
            className={clsx(
              'px-3 py-1 rounded-lg text-xs font-medium transition-all',
              filterSubjectId === 'all'
                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-bold'
                : 'bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200'
            )}
          >
            Todas ({notes.length})
          </button>
          {subjects.map((s) => (
            <button
              key={s.id}
              onClick={() => setFilterSubjectId(s.id)}
              className={clsx(
                'px-3 py-1 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5',
                filterSubjectId === s.id
                  ? 'bg-slate-800 text-slate-100 border border-slate-600 font-bold'
                  : 'bg-slate-900/60 border border-slate-800/80 text-slate-400 hover:text-slate-200'
              )}
            >
              <span
                className="w-2 h-2 rounded-full"
                style={{ backgroundColor: s.color }}
              />
              <span>{s.name}</span>
            </button>
          ))}
        </div>

        {/* Filtro por autor del apunte */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider mr-1">
            Autor:
          </span>
          <button
            onClick={() => setFilterAuthor('all')}
            className={clsx(
              'px-3 py-1 rounded-lg text-xs font-medium transition-all',
              filterAuthor === 'all'
                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-bold'
                : 'bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200'
            )}
          >
            Todos ({notes.length})
          </button>
          <button
            onClick={() => setFilterAuthor('catedratico')}
            className={clsx(
              'flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium transition-all',
              filterAuthor === 'catedratico'
                ? 'bg-violet-500/20 text-violet-200 border border-violet-500/40 font-bold'
                : 'bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200'
            )}
          >
            <Sparkles className="w-3 h-3" />
            <span>Del catedrático ({tutorNotes})</span>
          </button>
          <button
            onClick={() => setFilterAuthor('alumno')}
            className={clsx(
              'flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium transition-all',
              filterAuthor === 'alumno'
                ? 'bg-slate-700 text-slate-100 border border-slate-500 font-bold'
                : 'bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200'
            )}
          >
            <PenLine className="w-3 h-3" />
            <span>Míos ({ownNotes})</span>
          </button>
        </div>

        {/* Botones de Nuevo Apunte / Temario */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setIsNewTopicModalOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold transition-all border border-slate-700"
          >
            <Plus className="w-3.5 h-3.5 text-blue-400" />
            <span>+ Tema</span>
          </button>

          <button
            onClick={() => setIsNewSubjectModalOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold transition-all border border-slate-700"
          >
            <Plus className="w-3.5 h-3.5 text-purple-400" />
            <span>+ Asignatura</span>
          </button>

          <button
            onClick={handleCreateNewNote}
            disabled={isPending}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold transition-all shadow-[0_0_15px_rgba(16,185,129,0.3)] hover:scale-105"
          >
            <Plus className="w-4 h-4 stroke-[3]" />
            <span>Nuevo Apunte Notion</span>
          </button>
        </div>
      </div>

      {/* Grid del Workspace: Lista tipo Notion a la izquierda + Editor en grande a la derecha */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 min-h-[650px]">
        {/* Columna Izquierda: Páginas / Base de Datos Notion (4 cols) */}
        <div className="lg:col-span-4 rounded-2xl bg-[#0b101c] border border-white/10 p-4 flex flex-col justify-between space-y-3">
          <div className="space-y-3">
            <div className="flex items-center justify-between pb-2 border-b border-slate-800">
              <div className="flex items-center gap-2">
                <BookOpen className="w-4 h-4 text-emerald-400" />
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-200">
                  Cuaderno de Páginas ({filteredNotes.length})
                </h3>
              </div>

              {filterSubjectId !== 'all' && (
                <a
                  href={`/apuntes/imprimir?subject=${filterSubjectId}`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-[10px] font-semibold border border-slate-700 transition-all"
                  title="Imprimir todos los apuntes de esta asignatura, en orden de temario"
                >
                  <Printer className="w-3 h-3" />
                  <span>Imprimir asignatura</span>
                </a>
              )}
            </div>

            <div className="space-y-3 max-h-[550px] overflow-y-auto pr-1">
              {sections.map((section) => (
                <div key={section.id} className="space-y-2">
                  {/* Una sección por asignatura: el apartado de cada materia */}
                  <div className="flex items-center justify-between gap-2 px-1 pt-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: section.color }}
                      />
                      <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-300 truncate">
                        {section.name}
                      </h4>
                    </div>
                    <span className="text-[10px] text-slate-500 font-mono shrink-0">
                      {section.notes.length}
                    </span>
                  </div>

                  {section.notes.map(renderNoteCard)}
                </div>
              ))}

              {filteredNotes.length === 0 && (
                <div className="p-8 text-center text-xs text-slate-500 italic">
                  {notes.length === 0
                    ? 'Todavía no hay apuntes. Escríbelos tú, o pídeselos a un catedrático en /brainup: te pedirá permiso y los escribirá aquí, en el apartado de su asignatura.'
                    : 'No hay apuntes con el filtro seleccionado.'}
                </div>
              )}
            </div>
          </div>

          <div className="p-3 rounded-xl bg-[#080d17] border border-slate-800 text-[11px] text-slate-400">
            💡 Diseñado con formato compatible con Notion. Exportable a JSON en cualquier momento.
          </div>
        </div>

        {/* Columna Derecha: Editor Enriquecido Notion (8 cols) */}
        <div className="lg:col-span-8 rounded-2xl bg-[#0b101c] border border-white/10 p-6 flex flex-col justify-between space-y-4">
          {activeNote ? (
            <div className="space-y-4 flex-1 flex flex-col">
              {/* Barra superior de la página */}
              <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-800">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className="text-xs font-bold px-2 py-0.5 rounded border"
                    style={{
                      backgroundColor: `${activeNote.topic.subject.color}15`,
                      borderColor: `${activeNote.topic.subject.color}40`,
                      color: activeNote.topic.subject.color,
                    }}
                  >
                    {activeNote.topic.subject.name}
                  </span>
                  <span className="text-xs text-slate-400 font-medium">
                    {activeNote.topic.unitNumber ? `U${activeNote.topic.unitNumber} · ` : ''}
                    {activeNote.topic.title}
                  </span>
                  <AuthorBadge
                    author={activeNote.author}
                    agentName={activeNote.agent?.name ?? null}
                  />
                </div>

                <div className="flex items-center gap-2">
                  {/* Selector Vista / Edición */}
                  <div className="flex items-center rounded-lg border border-slate-800 bg-[#070b14] p-0.5">
                    <button
                      onClick={() => setViewMode('view')}
                      className={clsx(
                        'flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-semibold transition-all',
                        viewMode === 'view'
                          ? 'bg-slate-800 text-slate-100 shadow-sm'
                          : 'text-slate-400 hover:text-slate-200'
                      )}
                      title="Vista Notion enriquecida"
                    >
                      <Eye className="w-3 h-3" />
                      <span className="hidden sm:inline">Vista</span>
                    </button>
                    <button
                      onClick={() => setViewMode('edit')}
                      className={clsx(
                        'flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-semibold transition-all',
                        viewMode === 'edit'
                          ? 'bg-slate-800 text-slate-100 shadow-sm'
                          : 'text-slate-400 hover:text-slate-200'
                      )}
                      title="Editar Markdown"
                    >
                      <PenLine className="w-3 h-3" />
                      <span className="hidden sm:inline">Editar</span>
                    </button>
                  </div>

                  {saveStatus && (
                    <span className="text-xs font-mono font-bold text-emerald-400">
                      {saveStatus}
                    </span>
                  )}

                  <a
                    href={`/api/notes/${activeNote.id}/download`}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold border border-slate-700 transition-all"
                    title="Descargar este apunte en Markdown, para guardarlo o pasarlo a otro sitio"
                  >
                    <Download className="w-3 h-3" />
                    <span className="hidden sm:inline">Descargar .md</span>
                  </a>

                  <a
                    href={`/apuntes/imprimir?note=${activeNote.id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold border border-slate-700 transition-all"
                    title="Abrir la versión para imprimir: sin menús y con las fórmulas bien compuestas"
                  >
                    <Printer className="w-3 h-3" />
                    <span className="hidden sm:inline">Imprimir</span>
                  </a>

                  <a
                    href={`/enfoque?topicId=${activeNote.topicId}&technique=active_recall&duration=45`}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 text-xs font-semibold border border-emerald-500/30 transition-all"
                  >
                    <Play className="w-3 h-3 fill-emerald-400 text-emerald-400" />
                    <span>Estudiar con este Apunte</span>
                  </a>

                  <button
                    onClick={handleSave}
                    disabled={isPending}
                    className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold transition-all shadow-md"
                  >
                    <Save className="w-3.5 h-3.5" />
                    <span>Guardar</span>
                  </button>
                </div>
              </div>

              {/* Título de la página */}
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Título del Apunte (p.ej. Trigonometría: Fórmulas y Trucos)..."
                className="w-full text-xl sm:text-2xl font-black bg-transparent border-none text-slate-100 placeholder-slate-600 focus:outline-none"
              />

              {viewMode === 'view' ? (
                <div className="flex-1 min-h-[380px] max-h-[65vh] overflow-y-auto p-5 sm:p-7 bg-[#080d17] border border-slate-800 rounded-2xl">
                  <NoteRenderer content={content} />
                </div>
              ) : (
                <>
              {/* Barra de Herramientas Rápidas Notion */}
              <div className="flex flex-wrap items-center gap-1.5 p-2 rounded-xl bg-[#070b14] border border-slate-800 text-xs text-slate-400">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mr-1 pl-1">
                  Bloques:
                </span>
                <button
                  onClick={() => insertSnippet('### Nuevo Subtítulo')}
                  className="px-2 py-1 rounded hover:bg-slate-800 hover:text-slate-200 flex items-center gap-1 text-[11px]"
                  title="Subtítulo"
                >
                  <Heading2 className="w-3 h-3" /> H2
                </button>
                <button
                  onClick={() =>
                    insertSnippet(
                      '> 💡 **Pregunta Active Recall:** ¿Cuál es la condición fundamental?\n> *Respuesta oculta:* ...'
                    )
                  }
                  className="px-2 py-1 rounded bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/30 flex items-center gap-1 text-[11px]"
                  title="Bloque de Active Recall"
                >
                  <Sparkles className="w-3 h-3" /> Active Recall
                </button>
                <button
                  onClick={() =>
                    insertSnippet(
                      '| Concepto | Fórmula | Unidades |\n| :--- | :--- | :--- |\n| Fuerza | $F = m \\cdot a$ | Newtons (N) |\n| Trabajo | $W = F \\cdot d \\cdot \\cos(\\alpha)$ | Julios (J) |'
                    )
                  }
                  className="px-2 py-1 rounded hover:bg-slate-800 hover:text-slate-200 flex items-center gap-1 text-[11px]"
                  title="Tabla Comparativa"
                >
                  <Table className="w-3 h-3" /> Tabla
                </button>
                <button
                  onClick={() =>
                    insertSnippet(
                      '- [ ] 1. Repasar teoría sin apuntes\n- [ ] 2. Resolver 2 ejercicios tipo examen\n- [ ] 3. Registrar fallos en el Banco de Errores'
                    )
                  }
                  className="px-2 py-1 rounded hover:bg-slate-800 hover:text-slate-200 flex items-center gap-1 text-[11px]"
                  title="Checklist de Estudio"
                >
                  <CheckSquare className="w-3 h-3" /> Checklist
                </button>
                <button
                  onClick={() =>
                    insertSnippet(
                      '$$\\sin^2(x) + \\cos^2(x) = 1$$\n$$v = v_0 + a \\cdot t$$'
                    )
                  }
                  className="px-2 py-1 rounded hover:bg-slate-800 hover:text-slate-200 flex items-center gap-1 text-[11px]"
                  title="Fórmula Matemática"
                >
                  $ Fórmulas
                </button>
              </div>

              {/* Editor de Contenido Markdown */}
              <div className="flex-1 flex flex-col">
                <textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder="Comienza a escribir tus apuntes aquí... Usa Markdown, tablas, fórmulas o las herramientas de arriba."
                  className="w-full flex-1 min-h-[380px] p-4 bg-[#070b14] border border-slate-800 rounded-2xl text-xs sm:text-sm text-slate-200 font-mono leading-relaxed focus:outline-none focus:border-emerald-500/60 resize-y"
                />
              </div>
                </>
              )}

              {/* Tags */}
              <div className="flex items-center gap-2 pt-2 border-t border-slate-800">
                <Tag className="w-3.5 h-3.5 text-slate-500" />
                <span className="text-[11px] text-slate-400">Etiquetas:</span>
                <input
                  type="text"
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                  placeholder="fórmulas, resumen, examen..."
                  className="bg-transparent border-b border-slate-800 text-xs text-slate-300 focus:outline-none focus:border-emerald-400 px-1 py-0.5"
                />
              </div>
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center p-12 text-center text-slate-500 space-y-3">
              <BookOpen className="w-12 h-12 text-slate-700" />
              <p className="text-sm font-semibold text-slate-300">
                Selecciona una página a la izquierda o crea un nuevo apunte
              </p>
              <button
                onClick={handleCreateNewNote}
                className="px-4 py-2 rounded-xl bg-emerald-500 text-slate-950 font-bold text-xs"
              >
                + Crear Primer Apunte
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Modal: Crear Asignatura Personalizada */}
      {isNewSubjectModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-[#0e1628] border border-white/10 rounded-3xl w-full max-w-md p-6 shadow-2xl relative space-y-4">
            <button
              onClick={() => setIsNewSubjectModalOpen(false)}
              className="absolute top-4 right-4 text-slate-400 hover:text-slate-100"
            >
              <X className="w-5 h-5" />
            </button>

            <h3 className="text-base font-bold text-slate-100">
              Añadir Asignatura de 1º de Bachillerato
            </h3>
            <p className="text-xs text-slate-400">
              Personaliza tu temario exacto con las materias de tu instituto.
            </p>

            <form onSubmit={handleSaveSubject} className="space-y-4 pt-2">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Nombre de la Asignatura
                </label>
                <input
                  type="text"
                  placeholder="p.ej. Dibujo Técnico I, Francés, Anatomía..."
                  value={newSubjectForm.name}
                  onChange={(e) =>
                    setNewSubjectForm({ ...newSubjectForm, name: e.target.value })
                  }
                  required
                  className="w-full bg-[#080d18] border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-purple-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    Color Distintivo
                  </label>
                  <input
                    type="color"
                    value={newSubjectForm.color}
                    onChange={(e) =>
                      setNewSubjectForm({ ...newSubjectForm, color: e.target.value })
                    }
                    className="w-full h-9 bg-[#080d18] border border-slate-800 rounded-xl px-1 py-1 cursor-pointer"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    Ponderación PAU
                  </label>
                  <select
                    value={newSubjectForm.pauWeight}
                    onChange={(e) =>
                      setNewSubjectForm({
                        ...newSubjectForm,
                        pauWeight: Number(e.target.value),
                      })
                    }
                    className="w-full bg-[#080d18] border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-purple-500"
                  >
                    <option value={0.2}>Pondera 0.2 (Modalidad)</option>
                    <option value={0.1}>Pondera 0.1</option>
                    <option value={0.0}>Fase General (0.0)</option>
                  </select>
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsNewSubjectModalOpen(false)}
                  className="px-4 py-2 rounded-lg text-xs text-slate-400 hover:text-slate-200"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={isPending}
                  className="px-4 py-2 rounded-xl bg-purple-500 hover:bg-purple-400 text-white font-bold text-xs"
                >
                  Crear Asignatura
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Crear Tema Personalizado */}
      {isNewTopicModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-[#0e1628] border border-white/10 rounded-3xl w-full max-w-md p-6 shadow-2xl relative space-y-4">
            <button
              onClick={() => setIsNewTopicModalOpen(false)}
              className="absolute top-4 right-4 text-slate-400 hover:text-slate-100"
            >
              <X className="w-5 h-5" />
            </button>

            <h3 className="text-base font-bold text-slate-100">
              Añadir Tema al Temario
            </h3>
            <p className="text-xs text-slate-400">
              Registra un tema nuevo para tu planificador y cuaderno.
            </p>

            <form onSubmit={handleSaveTopic} className="space-y-4 pt-2">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Asignatura
                </label>
                <select
                  value={newTopicForm.subjectId}
                  onChange={(e) =>
                    setNewTopicForm({ ...newTopicForm, subjectId: e.target.value })
                  }
                  className="w-full bg-[#080d18] border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-blue-500"
                >
                  {subjects.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Título del Tema
                </label>
                <input
                  type="text"
                  placeholder="p.ej. Tema 4: Termoquímica y Entalpía"
                  value={newTopicForm.title}
                  onChange={(e) =>
                    setNewTopicForm({ ...newTopicForm, title: e.target.value })
                  }
                  required
                  className="w-full bg-[#080d18] border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Dificultad (1 a 5)
                </label>
                <input
                  type="number"
                  min="1"
                  max="5"
                  value={newTopicForm.difficulty}
                  onChange={(e) =>
                    setNewTopicForm({
                      ...newTopicForm,
                      difficulty: Number(e.target.value),
                    })
                  }
                  className="w-full bg-[#080d18] border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-blue-500"
                />
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsNewTopicModalOpen(false)}
                  className="px-4 py-2 rounded-lg text-xs text-slate-400 hover:text-slate-200"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={isPending}
                  className="px-4 py-2 rounded-xl bg-blue-500 hover:bg-blue-400 text-white font-bold text-xs"
                >
                  Añadir Tema
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
