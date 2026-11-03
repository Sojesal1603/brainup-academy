'use client';

import NeuralLoader from '@/components/ui/NeuralLoader';

import { useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Play, CheckCircle2, PauseCircle, RefreshCw, Timer } from 'lucide-react';
import { completeSession, pauseSession, recalculateToday } from '@/lib/actions';
import clsx from 'clsx';

interface SessionActionsProps {
  blockId: string;
  status: string;
  durationMinutes: number;
  spentMinutes: number;
  isCompleted: boolean;
}

/**
 * Los botones de una sesión: empezar, marcarla hecha o pausarla.
 *
 * Pausar guarda los minutos hechos en el bloque, así que al volver se continúa
 * donde se dejó (no se repite la sesión entera) y el plan del día descuenta lo
 * que ya está hecho.
 */
export default function SessionActions({
  blockId,
  status,
  durationMinutes,
  spentMinutes,
  isCompleted,
}: SessionActionsProps) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const remaining = Math.max(1, durationMinutes - spentMinutes);

  if (isCompleted) {
    return (
      <span className="flex items-center gap-1.5 text-[11px] font-semibold text-emerald-400">
        <CheckCircle2 className="w-4 h-4" /> Completada
      </span>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Link
        href={`/enfoque?block=${blockId}`}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold transition-all hover:scale-105"
      >
        <Play className="w-3 h-3 fill-slate-950" />
        <span>{status === 'parcial' ? `Continuar (${remaining} min)` : 'Empezar'}</span>
      </Link>

      {status === 'en_curso' || status === 'parcial' ? (
        <button
          onClick={() =>
            startTransition(async () => {
              await pauseSession(blockId, spentMinutes);
              router.refresh();
            })
          }
          disabled={isPending}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-900 text-slate-300 text-xs font-semibold hover:text-slate-100 transition-all disabled:opacity-50"
          title="Guardar lo hecho y continuar luego sin perder el progreso"
        >
          <PauseCircle className="w-3.5 h-3.5" />
          <span>Pausar</span>
        </button>
      ) : null}

      <button
        onClick={() =>
          startTransition(async () => {
            await completeSession(blockId);
            router.refresh();
          })
        }
        disabled={isPending}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 text-xs font-semibold hover:bg-emerald-500/20 transition-all disabled:opacity-50"
        title="Marcar la sesión como hecha"
      >
        <CheckCircle2 className="w-3.5 h-3.5" />
        <span>Hecha</span>
      </button>
    </div>
  );
}

/** Vuelve a calcular el plan de hoy con el tiempo que queda ahora mismo. */
export function RecalculatePlanButton({ compact = false }: { compact?: boolean }) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <>
      <button
        onClick={() =>
          startTransition(async () => {
            await recalculateToday();
            router.refresh();
          })
        }
        disabled={isPending}
        className={clsx(
          'flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 text-slate-300 font-semibold transition-all hover:text-slate-100 disabled:opacity-50',
          compact ? 'px-2.5 py-1.5 text-[11px]' : 'px-3 py-2 text-xs'
        )}
        title="Recalcula las sesiones de hoy con el tiempo que te queda"
      >
        <RefreshCw className={clsx('w-3.5 h-3.5', isPending && 'animate-spin')} />
        <span>{isPending ? 'Calculando…' : 'Recalcular'}</span>
        {!compact && <Timer className="w-3 h-3 text-slate-500" />}
      </button>

      {isPending && (
        <div className="fixed bottom-4 right-4 z-50 w-72 max-w-[calc(100vw-2rem)]">
          <NeuralLoader
            compact
            title="Repartiendo tu tiempo"
            messages={[
              'Optimizando planificación inversa...',
              'Ajustando sesiones al tiempo que queda...',
              'Revisando repasos vencidos y exámenes...',
            ]}
          />
        </div>
      )}
    </>
  );
}
