'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  EyeOff,
  Loader2,
  Pencil,
  RefreshCw,
  RotateCcw,
  Save,
  Sparkles,
  Wand2,
  X,
  XCircle,
} from 'lucide-react';
import clsx from 'clsx';
import NoteRenderer from './NoteRenderer';
import {
  StudyClientError,
  addVariant,
  createOutline,
  expandSection,
  getJob,
  loadOutline,
  reorderSections,
  setSectionSkipped,
  startExpandAll,
  tickJob,
  updateBlock,
  type StudyCanvasBlock,
  type StudyCanvasSection,
  type StudyNoteTree,
  type StudyQuoteStatus,
  type StudyVariantKind,
} from '@/lib/study/client';

/**
 * Lienzo modular de apuntes.
 *
 * El servidor ya sabe hacer todo (esquema, bloques, citas, trabajos
 * reanudables); este componente es la mitad que faltaba: enseña el árbol,
 * desarrolla apartados de uno en uno, deja editar sin que la IA lo pise y
 * conduce el trabajo completo con ticks reales.
 *
 * Regla de interfaz: nunca se enseña un número que no venga del servidor. La
 * cobertura es «apartados con cita verificada / apartados no omitidos», y el
 * progreso es `step / totalSteps` del `StudyJob`, no una animación.
 */

const VARIANT_ACTIONS: ReadonlyArray<{ kind: StudyVariantKind; label: string }> = [
  { kind: 'simpler', label: 'Más sencillo' },
  { kind: 'example', label: 'Un ejemplo' },
  { kind: 'deeper', label: 'Más profundo' },
];

const QUOTE_META: Record<StudyQuoteStatus, { label: string; className: string }> = {
  VERIFIED: {
    label: 'Cita verificada',
    className: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  },
  UNVERIFIED: {
    label: 'Cita sin verificar',
    className: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  },
  ERROR: {
    label: 'Cita con error',
    className: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
  },
  NONE: {
    label: 'Sin cita',
    className: 'border-slate-700 bg-slate-800/60 text-slate-400',
  },
};

interface Notice {
  tone: 'info' | 'warn' | 'error' | 'ok';
  text: string;
}

interface NoteCanvasProps {
  noteId: string;
  /** Mantiene sincronizado el Markdown proyectado que usa el resto del cuaderno. */
  onContentChange?: (content: string) => void;
}

function errorMessage(error: unknown): string {
  if (error instanceof StudyClientError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return 'Ha ocurrido un error inesperado.';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function CitationBadge({ status, quote }: { status: StudyQuoteStatus; quote: string | null }) {
  const meta = QUOTE_META[status] ?? QUOTE_META.NONE;
  const Icon =
    status === 'VERIFIED' ? CheckCircle2 : status === 'UNVERIFIED' ? AlertTriangle : status === 'ERROR' ? XCircle : EyeOff;

  return (
    <span
      className={clsx(
        'inline-flex max-w-full items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-bold',
        meta.className
      )}
      title={quote ? `«${quote}»` : 'Este bloque no trae una cita comprobable.'}
    >
      <Icon className="h-2.5 w-2.5 shrink-0" />
      <span className="truncate">{meta.label}</span>
    </span>
  );
}

interface BlockCardProps {
  noteId: string;
  block: StudyCanvasBlock;
  depth: number;
  onChanged: (message: string) => void;
  onError: (message: string) => void;
}

function BlockCard({ noteId, block, depth, onChanged, onError }: BlockCardProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(block.content);
  const [saving, setSaving] = useState(false);
  const [variantBusy, setVariantBusy] = useState<StudyVariantKind | null>(null);

  useEffect(() => {
    if (!editing) setDraft(block.content);
  }, [block.content, editing]);

  const startEditing = () => {
    setDraft(block.content);
    setEditing(true);
  };

  const handleSave = async () => {
    if (draft.trim().length === 0) {
      onError('Un bloque no puede quedarse vacío.');
      return;
    }
    setSaving(true);
    try {
      await updateBlock(noteId, block.id, draft);
      setEditing(false);
      onChanged('Bloque guardado. La IA ya no lo sobrescribirá.');
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const handleVariant = async (kind: StudyVariantKind) => {
    setVariantBusy(kind);
    try {
      const result = await addVariant(noteId, block.id, kind);
      onChanged(`Añadida «${result.block.label}» al bloque.`);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setVariantBusy(null);
    }
  };

  return (
    <div
      className={clsx(
        'rounded-xl border bg-[#070b14]/70 p-3 sm:p-4',
        depth === 0 ? 'border-slate-800' : 'border-slate-800/70 bg-[#0a1020]/70'
      )}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="rounded bg-slate-800/80 px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider text-slate-400">
          {block.type}
        </span>
        <CitationBadge status={block.quoteStatus} quote={block.quote} />
        {block.isEdited && (
          <span className="rounded border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-bold text-sky-300">
            Editado por ti
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {depth < 2 && !editing && (
            <div className="flex items-center gap-0.5">
              {VARIANT_ACTIONS.map((action) => (
                <button
                  key={action.kind}
                  type="button"
                  onClick={() => void handleVariant(action.kind)}
                  disabled={variantBusy !== null}
                  className="rounded px-1.5 py-1 text-[10px] font-semibold text-slate-400 transition hover:bg-slate-800 hover:text-slate-100 disabled:opacity-50"
                  title={`Pedir al catedrático: ${action.label.toLowerCase()}`}
                >
                  {variantBusy === action.kind ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    action.label
                  )}
                </button>
              ))}
            </div>
          )}
          {!editing && (
            <button
              type="button"
              onClick={startEditing}
              className="rounded p-1 text-slate-500 transition hover:bg-slate-800 hover:text-slate-200"
              title="Editar este bloque"
            >
              <Pencil className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {editing ? (
        <div className="space-y-2">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="min-h-[120px] w-full resize-y rounded-lg border border-slate-700 bg-[#050910] p-3 font-mono text-xs leading-relaxed text-slate-200 focus:border-emerald-500/60 focus:outline-none"
            placeholder="Escribe el bloque en Markdown. Las fórmulas, entre $$…$$."
          />
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setEditing(false)}
              disabled={saving}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-2.5 py-1 text-[11px] font-semibold text-slate-300 hover:bg-slate-800"
            >
              <X className="h-3 w-3" /> Cancelar
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving}
              className="inline-flex items-center gap-1 rounded-lg bg-emerald-500 px-2.5 py-1 text-[11px] font-bold text-slate-950 hover:bg-emerald-400 disabled:opacity-60"
            >
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
              Guardar bloque
            </button>
          </div>
        </div>
      ) : (
        <div className="text-xs leading-relaxed text-slate-200 sm:text-sm">
          <NoteRenderer content={block.content} />
        </div>
      )}
    </div>
  );
}

interface SectionCardProps {
  noteId: string;
  section: StudyCanvasSection;
  index: number;
  total: number;
  moving: boolean;
  onMove: (direction: -1 | 1) => void;
  onToggleSkip: () => void;
  onChanged: (message: string) => void;
  onError: (message: string) => void;
}

function SectionCard({
  noteId,
  section,
  index,
  total,
  moving,
  onMove,
  onToggleSkip,
  onChanged,
  onError,
}: SectionCardProps) {
  const [expanding, setExpanding] = useState(false);
  const skipped = section.status === 'SKIPPED';
  const verifiedBlocks = section.blocks.filter((block) => block.quoteStatus === 'VERIFIED').length;

  const childrenOf = useMemo(() => {
    const map = new Map<string | null, StudyCanvasBlock[]>();
    for (const block of section.blocks) {
      const list = map.get(block.parentId) ?? [];
      list.push(block);
      map.set(block.parentId, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.order - b.order);
    return map;
  }, [section.blocks]);

  const handleExpand = async () => {
    setExpanding(true);
    try {
      const result = await expandSection(noteId, section.id);
      const { verified, unverified, errors, kept } = result.generation;
      const detail = [
        `${verified} cita${verified === 1 ? '' : 's'} verificada${verified === 1 ? '' : 's'}`,
        unverified > 0 ? `${unverified} por revisar` : null,
        errors > 0 ? `${errors} con error` : null,
        kept > 0 ? `${kept} bloque${kept === 1 ? '' : 's'} tuyo${kept === 1 ? '' : 's'} conservado${kept === 1 ? '' : 's'}` : null,
      ]
        .filter(Boolean)
        .join(' · ');
      onChanged(`${section.title}: ${detail}.`);
      if (result.warning) onError(result.warning);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setExpanding(false);
    }
  };

  const renderBlock = (block: StudyCanvasBlock, depth: number): ReactNode => (
    <div key={block.id} className="space-y-2">
      <BlockCard
        noteId={noteId}
        block={block}
        depth={depth}
        onChanged={(message) => onChanged(message)}
        onError={onError}
      />
      {(childrenOf.get(block.id) ?? []).length > 0 && (
        <div className="ml-3 space-y-2 border-l border-slate-800 pl-3 sm:ml-4 sm:pl-4">
          {(childrenOf.get(block.id) ?? []).map((child) => renderBlock(child, depth + 1))}
        </div>
      )}
    </div>
  );

  return (
    <section
      className={clsx(
        'rounded-2xl border bg-[#080d17] p-3 sm:p-5',
        skipped ? 'border-slate-800/60 opacity-70' : 'border-slate-800'
      )}
    >
      <header className="flex flex-wrap items-start gap-2">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-800 font-mono text-[10px] font-bold text-slate-300">
          {index + 1}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-bold text-slate-100 sm:text-base">{section.title}</h3>
          {section.purpose && (
            <p className="mt-0.5 text-[11px] leading-relaxed text-slate-400">{section.purpose}</p>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span
              className={clsx(
                'rounded border px-1.5 py-0.5 text-[10px] font-bold',
                section.status === 'COMPLETED'
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                  : section.status === 'SKIPPED'
                    ? 'border-slate-700 bg-slate-800/60 text-slate-400'
                    : 'border-amber-500/40 bg-amber-500/10 text-amber-300'
              )}
            >
              {section.status === 'COMPLETED'
                ? 'Desarrollado'
                : section.status === 'SKIPPED'
                  ? 'Omitido'
                  : 'Pendiente'}
            </span>
            {section.blocks.length > 0 && (
              <span className="text-[10px] text-slate-500">
                {verifiedBlocks}/{section.blocks.length} bloques con cita verificada
              </span>
            )}
            {typeof section.coverage === 'number' && (
              <span className="text-[10px] text-slate-500">
                {Math.round(section.coverage * 100)}% de tus fuentes
              </span>
            )}
            {(section.pageFrom || section.pageTo) && (
              <span className="text-[10px] text-slate-500">
                pág. {section.pageFrom ?? '?'}–{section.pageTo ?? '?'}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onMove(-1)}
            disabled={index === 0 || moving}
            className="rounded border border-slate-700 p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100 disabled:opacity-40"
            title="Subir apartado"
          >
            <ArrowUp className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={() => onMove(1)}
            disabled={index === total - 1 || moving}
            className="rounded border border-slate-700 p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100 disabled:opacity-40"
            title="Bajar apartado"
          >
            <ArrowDown className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={onToggleSkip}
            className="inline-flex items-center gap-1 rounded border border-slate-700 px-2 py-1 text-[10px] font-semibold text-slate-300 hover:bg-slate-800"
            title={skipped ? 'Recuperar este apartado' : 'Omitir este apartado del apunte'}
          >
            {skipped ? <RotateCcw className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
            {skipped ? 'Recuperar' : 'Omitir'}
          </button>
          {!skipped && (
            <button
              type="button"
              onClick={() => void handleExpand()}
              disabled={expanding}
              className="inline-flex items-center gap-1 rounded-lg bg-emerald-500/15 px-2.5 py-1 text-[11px] font-bold text-emerald-300 ring-1 ring-emerald-500/40 transition hover:bg-emerald-500/25 disabled:opacity-60"
            >
              {expanding ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Sparkles className="h-3 w-3" />
              )}
              {section.blocks.length > 0 ? 'Volver a desarrollar' : 'Desarrollar'}
            </button>
          )}
        </div>
      </header>

      {section.blocks.length > 0 && !skipped && (
        <div className="mt-3 space-y-2">
          {(childrenOf.get(null) ?? []).map((block) => renderBlock(block, 0))}
        </div>
      )}

      {section.blocks.length === 0 && !skipped && (
        <p className="mt-3 rounded-lg border border-dashed border-slate-800 px-3 py-4 text-[11px] text-slate-500">
          Este apartado aún no tiene cuerpo. Desarróllalo solo cuando lo necesites: así no
          pagas la redacción de lo que no vas a estudiar.
        </p>
      )}
    </section>
  );
}

export default function NoteCanvas({ noteId, onContentChange }: NoteCanvasProps) {
  const [tree, setTree] = useState<StudyNoteTree | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [creatingOutline, setCreatingOutline] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [movingSectionId, setMovingSectionId] = useState<string | null>(null);
  const [expandingAll, setExpandingAll] = useState(false);
  const [progress, setProgress] = useState<{ step: number; total: number } | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);

  const contentRef = useRef(onContentChange);
  const runningRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    contentRef.current = onContentChange;
  }, [onContentChange]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const applyTree = useCallback((next: StudyNoteTree) => {
    setTree(next);
    contentRef.current?.(next.content);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setNotice(null);
    setJobError(null);
    setProgress(null);
    setTree(null);

    loadOutline(noteId)
      .then((next) => {
        if (cancelled) return;
        applyTree(next);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadError(errorMessage(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [noteId, applyTree]);

  const refresh = useCallback(async (): Promise<StudyNoteTree | null> => {
    try {
      const next = await loadOutline(noteId);
      if (mountedRef.current) applyTree(next);
      return next;
    } catch (error) {
      if (mountedRef.current) setLoadError(errorMessage(error));
      return null;
    }
  }, [noteId, applyTree]);

  const handleManualRefresh = async () => {
    setRefreshing(true);
    const next = await refresh();
    if (next) setNotice({ tone: 'ok', text: 'Lienzo actualizado.' });
    setRefreshing(false);
  };

  const handleCreateOutline = async () => {
    setCreatingOutline(true);
    setNotice({ tone: 'info', text: 'Leyendo tus fuentes y proponiendo apartados…' });
    try {
      const result = await createOutline(noteId);
      if (result.note) applyTree(result.note);
      if (result.created) {
        setNotice({
          tone: result.fallback ? 'warn' : 'ok',
          text: result.fallback
            ? result.warning ||
              'Esquema preparado con las etiquetas de tus fuentes, sin IA. Puedes desarrollarlo igual.'
            : 'Esquema preparado. Desarrolla los apartados que vayas a estudiar.',
        });
      } else {
        setNotice({
          tone: 'info',
          text: result.message || 'Este apunte ya tenía esquema: no se ha tocado.',
        });
      }
    } catch (error) {
      setNotice({ tone: 'error', text: errorMessage(error) });
    } finally {
      setCreatingOutline(false);
    }
  };

  const handleChanged = (message: string) => {
    setNotice({ tone: 'ok', text: message });
    void refresh();
  };

  const handleError = (message: string) => {
    setNotice({ tone: 'error', text: message });
  };

  const handleMove = async (section: StudyCanvasSection, direction: -1 | 1) => {
    if (!tree) return;
    const index = tree.sections.findIndex((item) => item.id === section.id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= tree.sections.length) return;

    const ordered = tree.sections.map((item) => item.id);
    const [moved] = ordered.splice(index, 1);
    ordered.splice(target, 0, moved);

    setMovingSectionId(section.id);
    try {
      await reorderSections(noteId, ordered);
      await refresh();
      setNotice({ tone: 'ok', text: 'Orden de los apartados guardado.' });
    } catch (error) {
      setNotice({ tone: 'error', text: errorMessage(error) });
    } finally {
      setMovingSectionId(null);
    }
  };

  const handleToggleSkip = async (section: StudyCanvasSection) => {
    try {
      await setSectionSkipped(noteId, section.id, section.status !== 'SKIPPED');
      await refresh();
      setNotice({
        tone: 'ok',
        text:
          section.status === 'SKIPPED'
            ? 'Apartado recuperado en el apunte.'
            : 'Apartado omitido: no se proyecta al Markdown ni se desarrolla.',
      });
    } catch (error) {
      setNotice({ tone: 'error', text: errorMessage(error) });
    }
  };

  const handleExpandAll = async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setExpandingAll(true);
    setJobError(null);
    setNotice({ tone: 'info', text: 'Preparando el desarrollo completo…' });

    try {
      const started = await startExpandAll(noteId);
      setNotice({
        tone: 'info',
        text: started.resumed
          ? 'Se reanuda un desarrollo que ya estaba en marcha.'
          : 'Desarrollando el tema apartado a apartado.',
      });
      setProgress({ step: 0, total: started.totalSteps ?? 0 });

      let finished = false;
      for (let attempt = 0; attempt < 80 && !finished; attempt += 1) {
        let tick;
        try {
          tick = await tickJob(started.jobId);
        } catch (error) {
          if (error instanceof StudyClientError && error.status === 409 && error.retry) {
            await sleep(1_500);
            continue;
          }
          throw error;
        }

        if (tick.job) {
          setProgress({ step: tick.job.step, total: tick.job.totalSteps });
        }

        const snapshot = await getJob(started.jobId);
        if (mountedRef.current) {
          setProgress({ step: snapshot.job.step, total: snapshot.job.totalSteps });
        }

        await refresh();

        if (snapshot.job.status === 'failed') {
          setJobError(snapshot.job.error || 'El trabajo se ha detenido a mitad.');
          finished = true;
          break;
        }
        if (tick.finished || snapshot.job.status === 'done') {
          finished = true;
          break;
        }

        await sleep(1_500);
      }

      if (finished) {
        setNotice({
          tone: 'ok',
          text: 'Desarrollo completo terminado. Revisa las citas marcadas en ámbar.',
        });
      } else {
        setNotice({
          tone: 'warn',
          text: 'El trabajo sigue en marcha en el servidor. Vuelve a entrar y se reanudará.',
        });
      }
      await refresh();
    } catch (error) {
      setJobError(errorMessage(error));
      setNotice({ tone: 'error', text: errorMessage(error) });
    } finally {
      runningRef.current = false;
      if (mountedRef.current) setExpandingAll(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-[320px] items-center justify-center rounded-2xl border border-slate-800 bg-[#080d17]">
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <Loader2 className="h-4 w-4 animate-spin text-emerald-400" />
          Leyendo el esquema del apunte…
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="space-y-3 rounded-2xl border border-rose-500/30 bg-rose-500/5 p-5 text-sm text-rose-200">
        <p className="flex items-center gap-2 font-bold">
          <AlertTriangle className="h-4 w-4" /> No se ha podido abrir el lienzo
        </p>
        <p className="text-xs text-rose-200/80">{loadError}</p>
        <button
          type="button"
          onClick={() => void handleManualRefresh()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/40 px-3 py-1.5 text-xs font-bold text-rose-200 hover:bg-rose-500/10"
        >
          <RefreshCw className="h-3 w-3" /> Reintentar
        </button>
      </div>
    );
  }

  const pendingCount = tree?.sections.filter((section) => section.status === 'PENDING').length ?? 0;
  const progressRatio =
    progress && progress.total > 0 ? Math.min(100, Math.round((progress.step / progress.total) * 100)) : 0;

  return (
    <div className="space-y-4">
      {notice && (
        <div
          className={clsx(
            'flex items-start gap-2 rounded-xl border px-3 py-2 text-[11px] leading-relaxed',
            notice.tone === 'ok' && 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
            notice.tone === 'info' && 'border-sky-500/30 bg-sky-500/10 text-sky-200',
            notice.tone === 'warn' && 'border-amber-500/30 bg-amber-500/10 text-amber-200',
            notice.tone === 'error' && 'border-rose-500/30 bg-rose-500/10 text-rose-200'
          )}
        >
          <span className="flex-1">{notice.text}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="shrink-0 opacity-70 hover:opacity-100"
            title="Cerrar aviso"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {jobError && (
        <p className="rounded-xl border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-[11px] text-rose-200">
          {jobError}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-800 bg-[#070b14] px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-bold text-slate-200">
            {tree && tree.sections.length > 0
              ? `${tree.sections.length} apartados · ${tree.coverage.withCitation}/${tree.coverage.total} con cita verificada`
              : 'Sin esquema todavía'}
          </p>
          {tree && tree.sections.length > 0 && (
            <div className="mt-1 h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-slate-800">
              <div
                className="h-full rounded-full bg-emerald-500 transition-all"
                style={{ width: `${Math.round(tree.coverage.ratio * 100)}%` }}
              />
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={() => void handleManualRefresh()}
          disabled={refreshing || expandingAll}
          className="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-2.5 py-1 text-[11px] font-semibold text-slate-300 hover:bg-slate-800 disabled:opacity-50"
          title="Volver a leer el árbol del servidor"
        >
          {refreshing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          Actualizar
        </button>

        {tree && tree.sections.length > 0 && (
          <button
            type="button"
            onClick={() => void handleExpandAll()}
            disabled={expandingAll || pendingCount === 0}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1 text-[11px] font-bold text-slate-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
            title={
              pendingCount === 0
                ? 'No quedan apartados pendientes'
                : 'Desarrollar todos los apartados pendientes, uno a uno'
            }
          >
            {expandingAll ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />}
            {expandingAll ? 'Desarrollando…' : `Desarrollar todo (${pendingCount})`}
          </button>
        )}
      </div>

      {expandingAll && progress && progress.total > 0 && (
        <div className="space-y-1 rounded-xl border border-slate-800 bg-[#070b14] px-3 py-2">
          <div className="flex items-center justify-between text-[10px] font-mono font-bold text-slate-400">
            <span>Trabajo completo</span>
            <span>
              {progress.step}/{progress.total} · {progressRatio}%
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-slate-800">
            <div
              className="h-full rounded-full bg-emerald-500 transition-all"
              style={{ width: `${progressRatio}%` }}
            />
          </div>
          <p className="text-[10px] text-slate-500">
            Cada paso es un apartado redactado y validado. No cierres la pestaña: el progreso vive
            en el servidor, pero es esta pantalla quien pide los pasos.
          </p>
        </div>
      )}

      {!tree || tree.sections.length === 0 ? (
        <div className="space-y-3 rounded-2xl border border-slate-800 bg-[#080d17] p-6 text-center">
          <p className="text-sm font-bold text-slate-100">Primero el esquema, después el cuerpo</p>
          <p className="mx-auto max-w-lg text-[11px] leading-relaxed text-slate-400">
            El lienzo propone los apartados a partir de tus fuentes en segundos. Así ves la
            estructura antes de pagar la redacción completa, y puedes desarrollar solo lo que
            vayas a estudiar.
          </p>
          <button
            type="button"
            onClick={() => void handleCreateOutline()}
            disabled={creatingOutline}
            className="inline-flex items-center gap-2 rounded-xl bg-emerald-500 px-4 py-2 text-xs font-bold text-slate-950 transition hover:bg-emerald-400 disabled:opacity-60"
          >
            {creatingOutline ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            {creatingOutline ? 'Preparando esquema…' : 'Preparar esquema'}
          </button>
          <p className="text-[10px] text-slate-500">
            Sin fuentes subidas se usan las etiquetas de la unidad y se avisa: no se inventan citas.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {tree.sections.map((section, index) => (
            <SectionCard
              key={section.id}
              noteId={noteId}
              section={section}
              index={index}
              total={tree.sections.length}
              moving={movingSectionId !== null}
              onMove={(direction) => void handleMove(section, direction)}
              onToggleSkip={() => void handleToggleSkip(section)}
              onChanged={handleChanged}
              onError={handleError}
            />
          ))}
        </div>
      )}
    </div>
  );
}
