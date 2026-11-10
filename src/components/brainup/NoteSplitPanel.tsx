'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import {
  BookOpen,
  Check,
  Download,
  FileText,
  Loader2,
  MessageSquare,
  ScrollText,
  X,
} from 'lucide-react';
import NoteRenderer from '@/components/apuntes/NoteRenderer';
import clsx from 'clsx';

/**
 * Lo que se está leyendo en el panel: un borrador recién escrito por el
 * catedrático o un apunte que ya está en el cuaderno.
 */
export interface SplitNote {
  title: string;
  /** «Unidad 4 · Matrices», o `null` si la unidad no está numerada. */
  unitLabel: string | null;
  /** Número de unidad, para poder pedir otra versión del mismo tema. */
  unitNumber?: number | null;
  /** Id de la unidad: la forma más fiable de pedir otra versión. */
  topicId?: string;
  subjectName: string;
  authorLabel: string;
  content: string;
  /** Id del apunte guardado; ausente mientras es un borrador. */
  noteId?: string;
  words?: number;
  updatedLabel?: string;
  /** `true` = todavía no está en el cuaderno (se puede guardar desde aquí). */
  isDraft: boolean;
}

/**
 * Una versión del apunte, escrita por un motor concreto.
 *
 * La comparativa vive aquí y no en el chat porque es una lectura: se alterna
 * entre versiones sin tocar el hilo, y solo la que se está leyendo se guarda.
 */
export interface NoteVariant {
  /** Id del proveedor (`gemini`, `groq`, …). */
  engine: string;
  label: string;
  /** Modelo exacto que la ha escrito, cuando ya está lista. */
  model: string;
  status: 'ready' | 'pending' | 'error';
  error?: string;
  /** Vale del borrador en el servidor: con él se guarda sin gastar otra llamada. */
  token?: string;
  title?: string;
  content?: string;
  words?: number;
}

/** Un motor disponible para pedir una versión. */
export interface EngineOption {
  id: string;
  name: string;
}

/** Qué se ve en el panel: el chat a todo el ancho, el texto o el folio digital. */
export type PanelMode = 'chat' | 'markdown' | 'pdf';

function VariantTabs({
  variants,
  engines,
  activeEngine,
  onSelectEngine,
  onGenerate,
}: {
  variants: NoteVariant[];
  engines: EngineOption[];
  activeEngine: string;
  onSelectEngine: (engine: string) => void;
  onGenerate: (engine: string) => void;
}) {
  // Los motores configurados y, si alguno ya no lo está, la versión que ya
  // tenemos: nunca se oculta una versión ya escrita.
  const options: EngineOption[] = [...engines];
  for (const variant of variants) {
    if (!options.some((engine) => engine.id === variant.engine)) {
      options.push({ id: variant.engine, name: variant.label });
    }
  }
  if (options.length === 0) return null;

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="mr-1 font-mono text-[9px] uppercase tracking-[0.16em] text-stone-500">
        Versión
      </span>
      {options.map((engine) => {
        const variant = variants.find((item) => item.engine === engine.id);
        const active = activeEngine === engine.id;
        const pending = variant?.status === 'pending';
        const failed = variant?.status === 'error';
        return (
          <button
            key={engine.id}
            onClick={() => (variant?.status === 'ready' ? onSelectEngine(engine.id) : onGenerate(engine.id))}
            disabled={pending}
            title={
              failed
                ? variant?.error || `No se pudo escribir con ${engine.name}`
                : variant?.status === 'ready'
                  ? `Leer la versión de ${engine.name}${variant.model ? ` (${variant.model})` : ''}`
                  : `Pedir esta misma unidad a ${engine.name}`
            }
            className={clsx(
              'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10.5px] font-medium transition-colors',
              active
                ? 'border-stone-200/70 bg-stone-200 text-stone-900'
                : failed
                  ? 'border-rose-500/40 text-rose-300 hover:border-rose-400/60'
                  : 'border-white/10 text-stone-400 hover:border-white/25 hover:text-stone-100',
              pending && 'opacity-60'
            )}
          >
            {pending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : failed ? (
              <span className="h-1.5 w-1.5 rounded-full bg-rose-400" />
            ) : null}
            {engine.name}
            {variant?.status === 'ready' && variant.model && (
              <span
                className={clsx(
                  'hidden font-mono text-[9px] sm:inline',
                  active ? 'text-stone-600' : 'text-stone-600'
                )}
              >
                {variant.model}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Vista dividida: el documento a la derecha, el chat a la izquierda.
 *
 * Dos lecturas con scroll propio: el chat se desplaza dentro de su columna y el
 * documento dentro de la suya, así se puede estudiar sin perder el hilo de la
 * conversación.
 *
 * El «PDF digital» NO abre el diálogo de impresión: es una hoja DIN-A4 pintada
 * dentro de la propia app, con tipografía de estudio, para leer de inmediato.
 *
 * El panel no guarda nada por su cuenta: pide al chat que guarde la versión
 * abierta o que vuelva al chat. Así hay un único dueño del estado.
 */
export default function NoteSplitPanel({
  note,
  mode,
  onMode,
  onClose,
  onSave,
  saving = false,
  variants = [],
  engines = [],
  activeEngine = '',
  onSelectEngine,
  onGenerate,
}: {
  note: SplitNote | null;
  mode: Exclude<PanelMode, 'chat'>;
  onMode: (mode: PanelMode) => void;
  onClose: () => void;
  /** Solo para borradores: guardar la versión que se está leyendo. */
  onSave?: () => void;
  saving?: boolean;
  variants?: NoteVariant[];
  engines?: EngineOption[];
  activeEngine?: string;
  onSelectEngine?: (engine: string) => void;
  onGenerate?: (engine: string) => void;
}) {
  // Escape vuelve al chat: es la tecla que todo el mundo prueba.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const canCompare =
    note?.isDraft && variants.length > 0 && Boolean(onSelectEngine) && Boolean(onGenerate);

  return (
    <section
      className="chat-panel fixed inset-0 z-[70] flex min-h-0 min-w-0 flex-col overflow-hidden bg-[#0c0b0a] md:static md:z-auto md:h-full md:border-l md:border-white/[0.07]"
      aria-label={note ? `Documento: ${note.title}` : 'Visor de documentos'}
    >
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-white/[0.07] px-4 py-3 sm:px-5">
        <div className="min-w-0">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-stone-500">
            {note ? `Documento · ${note.subjectName}` : 'Visor de estudio'}
          </p>
          <h2 className="mt-1 truncate font-serif text-[17px] leading-snug text-stone-100">
            {note ? note.title : 'Tu documento, al lado del chat'}
          </h2>
          <p className="mt-0.5 truncate text-[11px] text-stone-500">
            {note
              ? [
                  note.unitLabel,
                  note.authorLabel,
                  note.updatedLabel,
                  note.words ? `${note.words} palabras` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')
              : 'Selecciona un apunte en el chat o pídele uno al catedrático.'}
          </p>
        </div>
        <button
          onClick={onClose}
          title="Volver al chat"
          aria-label="Volver al chat"
          className="shrink-0 rounded-lg border border-white/10 bg-white/[0.03] p-1.5 text-stone-400 transition-colors hover:border-white/20 hover:text-stone-100"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      {/* Selector de vista: el chat, el texto o el folio digital. */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-white/[0.05] px-3 py-2 sm:px-4">
        <div className="flex items-center gap-0.5 rounded-lg border border-white/10 p-0.5">
          {(
            [
              { id: 'chat', label: 'Chat', icon: MessageSquare },
              { id: 'markdown', label: 'Markdown', icon: ScrollText },
              { id: 'pdf', label: 'Vista PDF digital', icon: FileText },
            ] as const
          ).map((option) => (
            <button
              key={option.id}
              onClick={() => onMode(option.id)}
              aria-pressed={option.id === mode}
              className={clsx(
                'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] font-medium transition-colors',
                option.id === mode
                  ? 'bg-white/[0.08] text-stone-100'
                  : 'text-stone-500 hover:text-stone-200'
              )}
            >
              <option.icon className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{option.label}</span>
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {note?.isDraft && onSave && (
            <button
              onClick={onSave}
              disabled={saving}
              className="flex items-center gap-1.5 rounded-lg bg-stone-200 px-2.5 py-1.5 text-[11px] font-semibold text-stone-900 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              {saving ? 'Guardando…' : 'Guardar esta versión'}
            </button>
          )}

          {note?.noteId && (
            <>
              <a
                href={`/api/notes/${note.noteId}/download`}
                className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-[11px] font-medium text-stone-300 transition-colors hover:border-white/20 hover:text-stone-100"
              >
                <Download className="h-3.5 w-3.5" />
                .md
              </a>
              <Link
                href="/apuntes"
                className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-[11px] font-medium text-stone-300 transition-colors hover:border-white/20 hover:text-stone-100"
              >
                <BookOpen className="h-3.5 w-3.5" />
                Cuaderno
              </Link>
            </>
          )}
        </div>
      </div>

      {/* Comparativa multi-IA: la misma unidad, tantas versiones como motores. */}
      {canCompare && (
        <div className="shrink-0 overflow-x-auto border-b border-white/[0.05] px-3 py-2 sm:px-4">
          <VariantTabs
            variants={variants}
            engines={engines}
            activeEngine={activeEngine}
            onSelectEngine={(engine) => onSelectEngine?.(engine)}
            onGenerate={(engine) => onGenerate?.(engine)}
          />
        </div>
      )}

      {!note ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-8">
          <div className="max-w-sm space-y-2 text-center">
            <FileText className="mx-auto h-7 w-7 text-stone-600" />
            <p className="font-serif text-[15px] text-stone-300">Aquí se lee lo que te escribe</p>
            <p className="text-[12px] leading-relaxed text-stone-500">
              Cuando el catedrático te ofrezca unos apuntes, se abrirán en este panel. Podrás
              comparar la versión de cada motor de IA y guardar la que prefieras, sin salir del chat.
            </p>
          </div>
        </div>
      ) : mode === 'pdf' ? (
        <div className="min-h-0 flex-1 overflow-y-auto bg-[#151412] px-3 py-6 sm:px-6">
          <div className="note-paper mx-auto w-full max-w-[210mm] min-h-[297mm] px-7 py-10 sm:px-[16mm] sm:py-[14mm]">
            <p className="font-mono text-[9px] uppercase tracking-[0.22em] text-stone-600">
              BrainUp Academy · {note.subjectName} · Documento de estudio
            </p>
            <h1 className="mt-3 font-serif text-[26px] font-semibold leading-tight tracking-[-0.01em]">
              {note.title}
            </h1>
            <p className="mt-1 text-[10.5px] text-stone-600">
              {[note.unitLabel, note.authorLabel, note.updatedLabel].filter(Boolean).join(' · ')}
            </p>
            <hr className="my-5 border-stone-400/60" />
            <article className="note-paper-body">
              <NoteRenderer content={note.content} revealAnswers />
            </article>
            <p className="mt-10 border-t border-stone-400/40 pt-2 text-center font-mono text-[8.5px] uppercase tracking-[0.22em] text-stone-500">
              BrainUp Academy · {note.words ? `${note.words} palabras` : 'apunte de cátedra'}
            </p>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6 sm:px-8">
          <article className="mx-auto max-w-[46rem]">
            <NoteRenderer content={note.content} revealAnswers />
          </article>
        </div>
      )}
    </section>
  );
}
