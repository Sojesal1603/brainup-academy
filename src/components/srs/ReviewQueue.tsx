'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';
import { CalendarClock, CheckCircle2, Loader2, Repeat, Sparkles } from 'lucide-react';
import { SRS_RATINGS, SRS_RATING_ORDER, retentionTone, type SrsRating } from '@/lib/srs';
import { recordSrsReview } from '@/lib/srsActions';

/**
 * La cola de repaso, con las valoraciones.
 *
 * Cada botón registra el repaso en el servidor (`recordSrsReview`) y **enseña el
 * intervalo nuevo** en el sitio: «vuelve en 6 días». Es la única forma de que el
 * alumno entienda que lo que acaba de contestar cambia su calendario; si no lo
 * ve, la valoración parece un botón decorativo.
 *
 * Después se refresca la página para que la cola, los indicadores y la analítica
 * se recalculen con el repaso ya dentro.
 */

/** Una unidad de la cola, ya resuelta para pintar (el servidor la prepara). */
export interface ReviewItemView {
  topicId: string;
  title: string;
  unitLabel: string | null;
  subjectName: string;
  subjectColor: string;
  /** Toca hoy o está vencida. */
  due: boolean;
  /** Días hasta el repaso (negativo = vencida). */
  daysUntil: number;
  overdue: number;
  /** Retención estimada (0-100) o `null` si nunca se ha repasado. */
  retention: number | null;
  /** «toca hoy», «en 4 días», «vencida hace 3 días». */
  scheduleLabel: string;
  /** «ayer», «hace 5 días». */
  lastReviewedLabel: string | null;
}

interface ReviewQueueProps {
  due: ReviewItemView[];
  upcoming: ReviewItemView[];
  starters: ReviewItemView[];
}

interface Feedback {
  ok: boolean;
  text: string;
}

/** «mañana» / «en 6 días», para el mensaje posterior al repaso. */
function formatInterval(intervalDays: number): string {
  if (intervalDays <= 1) return 'mañana';
  return `en ${intervalDays} días`;
}

export default function ReviewQueue({ due, upcoming, starters }: ReviewQueueProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<string, Feedback>>({});

  const rate = (topicId: string, rating: SrsRating) => {
    if (busy) return;
    setBusy(topicId);

    startTransition(async () => {
      const result = await recordSrsReview({ topicId, rating });
      setBusy(null);

      if (!result.success) {
        setFeedback((prev) => ({
          ...prev,
          [topicId]: { ok: false, text: result.error ?? 'No se ha podido guardar el repaso.' },
        }));
        return;
      }

      setFeedback((prev) => ({
        ...prev,
        [topicId]: {
          ok: true,
          text: result.closed
            ? `Repaso guardado · ${formatInterval(result.intervalDays ?? 1)} · unidad cerrada como repasada`
            : `Repaso guardado · vuelve ${formatInterval(result.intervalDays ?? 1)}`,
        },
      }));

      router.refresh();
    });
  };

  const renderRow = (item: ReviewItemView, variant: 'due' | 'upcoming' | 'starter') => {
    const tone = retentionTone(item.retention);
    const message = feedback[item.topicId];
    const isBusy = busy === item.topicId;

    return (
      <div
        key={item.topicId}
        className={clsx(
          'p-4 rounded-2xl border transition-all',
          variant === 'due'
            ? 'glass-card border-amber-500/30'
            : 'glass-card border-white/10'
        )}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: item.subjectColor }}
              />
              <span className="text-[10px] font-mono uppercase tracking-widest text-slate-500">
                {item.subjectName}
                {item.unitLabel ? ` · ${item.unitLabel}` : ''}
              </span>
              {item.retention !== null ? (
                <span className={clsx('text-[10px] font-mono font-bold', tone.className)}>
                  {item.retention}% · {tone.label}
                </span>
              ) : (
                <span className="text-[10px] font-mono text-slate-500">sin repasar</span>
              )}
            </div>

            <h4 className="text-sm font-semibold text-slate-100 mt-1.5 truncate">{item.title}</h4>

            <p className="text-[11px] text-slate-500 mt-0.5">
              {variant === 'starter' ? (
                <span className="text-slate-400">
                  <Sparkles className="w-3 h-3 inline mr-1 -mt-0.5" />
                  Primera pasada: al valorarla arranca su calendario
                </span>
              ) : (
                <>
                  Repaso {item.scheduleLabel}
                  {item.lastReviewedLabel ? ` · última vez ${item.lastReviewedLabel}` : ''}
                  {item.overdue > 0 ? ` · ${item.overdue} de retraso` : ''}
                </>
              )}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {SRS_RATING_ORDER.map((rating) => {
              const meta = SRS_RATINGS[rating];
              return (
                <button
                  key={rating}
                  type="button"
                  onClick={() => rate(item.topicId, rating)}
                  disabled={busy !== null}
                  title={`${meta.label} — ${meta.description}`}
                  className={clsx(
                    'px-2.5 py-1.5 rounded-lg border text-[11px] font-bold transition-all disabled:opacity-40',
                    meta.buttonClass,
                    isBusy && 'cursor-wait'
                  )}
                >
                  {isBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : meta.short}
                </button>
              );
            })}
          </div>
        </div>

        {message && (
          <p
            className={clsx(
              'text-[11px] mt-2 flex items-center gap-1.5',
              message.ok ? 'text-emerald-400' : 'text-rose-400'
            )}
          >
            {message.ok && <CheckCircle2 className="w-3.5 h-3.5" />}
            {message.text}
          </p>
        )}
      </div>
    );
  };

  const everythingEmpty = due.length === 0 && upcoming.length === 0 && starters.length === 0;

  if (everythingEmpty) {
    return (
      <div className="p-6 rounded-2xl glass-card space-y-2">
        <div className="flex items-center gap-2">
          <CalendarClock className="w-4 h-4 text-slate-500" />
          <h3 className="text-sm font-bold uppercase tracking-wider text-slate-200">
            Cola de repaso
          </h3>
        </div>
        <p className="text-xs text-slate-400 leading-relaxed">
          No hay nada en el calendario todavía. El repaso espaciado empieza con la primera pasada, y
          esa sale de tus unidades ya dadas en clase: márcalas en el <strong>Temario</strong> (vista o
          en curso) y aparecerán aquí para estrenar su calendario.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Lo que toca hoy */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold uppercase tracking-wider text-slate-200 flex items-center gap-2">
            <CalendarClock className="w-4 h-4 text-amber-400" />
            <span>Repasos de hoy</span>
          </h3>
          <span className="text-xs font-mono text-slate-400">{due.length}</span>
        </div>

        {due.length === 0 ? (
          <p className="text-xs text-slate-400 px-1">
            Nada vencido hoy: el calendario está al día. Lo que viene después está justo debajo.
          </p>
        ) : (
          <div className="space-y-2">{due.map((item) => renderRow(item, 'due'))}</div>
        )}
      </section>

      {/* Lo que viene */}
      {upcoming.length > 0 && (
        <section className="space-y-3">
          <h3 className="text-sm font-bold uppercase tracking-wider text-slate-200 flex items-center gap-2">
            <Repeat className="w-4 h-4 text-sky-400" />
            <span>Después</span>
          </h3>
          <p className="text-[11px] text-slate-500 px-1">
            Ya programado. Puedes adelantarlo si le has dado otra vuelta por tu cuenta.
          </p>
          <div className="space-y-2">{upcoming.map((item) => renderRow(item, 'upcoming'))}</div>
        </section>
      )}

      {/* Primera pasada de lo ya dado en clase */}
      <section className="space-y-3">
        <h3 className="text-sm font-bold uppercase tracking-wider text-slate-200 flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-emerald-400" />
          <span>Primera pasada</span>
        </h3>
        {starters.length === 0 ? (
          <p className="text-xs text-slate-400 px-1">
            No quedan unidades dadas en clase sin calendario: todas las que has visto ya entraron en
            el SRS.
          </p>
        ) : (
          <>
            <p className="text-[11px] text-slate-500 px-1">
              Unidades que ya has dado en clase y todavía no han pasado por el calendario. Valora la
              primera pasada y su intervalo empieza a contar desde cero.
            </p>
            <div className="space-y-2">{starters.map((item) => renderRow(item, 'starter'))}</div>
          </>
        )}
      </section>

      {isPending && <p className="text-[11px] text-slate-500 px-1">Guardando…</p>}
    </div>
  );
}
