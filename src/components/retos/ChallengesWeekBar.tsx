'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';
import { CalendarRange, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { refreshWeeklyChallenges } from '@/lib/challengeActions';

/**
 * Barra de la semana de retos.
 *
 * Es la única parte de la página que pide algo al servidor, y hace una cosa muy
 * concreta: generar los retos si la semana todavía no los tiene y volver a medir
 * el progreso con lo que haya en la base. El botón no inventa nada: lo que suma
 * son sesiones, repasos y errores cerrados de verdad.
 *
 * Después del clic se cuenta lo que ha pasado («2 retos nuevos · +140 XP») en
 * lugar de recargar en silencio: si aparece un reto, el alumno tiene que saber
 * de dónde sale.
 */

interface ChallengesWeekBarProps {
  weekLabel: string;
  weekKey: string;
  counts: { active: number; completed: number; expired: number };
  totalXp: number;
  hasChallenges: boolean;
}

export default function ChallengesWeekBar({
  weekLabel,
  weekKey,
  counts,
  totalXp,
  hasChallenges,
}: ChallengesWeekBarProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  function handleRefresh() {
    if (isPending) return;
    setNote('');
    setError('');

    startTransition(async () => {
      const result = await refreshWeeklyChallenges();

      if (!result.success) {
        setError(result.error ?? 'No se han podido actualizar los retos.');
        return;
      }

      const parts: string[] = [];
      if (result.created > 0) {
        parts.push(`${result.created} ${result.created === 1 ? 'reto nuevo' : 'retos nuevos'}`);
      }
      if (result.earnedXp > 0) parts.push(`+${result.earnedXp} XP`);
      if (result.completed > 0) parts.push(`${result.completed} conseguido${result.completed === 1 ? '' : 's'}`);

      setNote(
        parts.length > 0
          ? parts.join(' · ')
          : 'Todo al día: no había nada nuevo que medir.'
      );

      router.refresh();
    });
  }

  return (
    <div className="p-5 rounded-2xl glass-card space-y-3">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <CalendarRange className="w-4 h-4 text-emerald-400" />
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-slate-200">
              Semana del {weekLabel}
            </p>
            <p className="text-[10px] text-slate-500 font-mono">{weekKey}</p>
          </div>
        </div>

        <button
          type="button"
          onClick={handleRefresh}
          disabled={isPending}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-500 px-4 py-2.5 text-xs font-bold text-slate-950 transition-all hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isPending ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Midiendo…</span>
            </>
          ) : hasChallenges ? (
            <>
              <RefreshCw className="w-4 h-4" />
              <span>Actualizar progreso</span>
            </>
          ) : (
            <>
              <Sparkles className="w-4 h-4" />
              <span>Generar los retos de esta semana</span>
            </>
          )}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono">
        <span className="px-2 py-0.5 rounded border bg-sky-500/10 text-sky-400 border-sky-500/30">
          {counts.active} en juego
        </span>
        <span className="px-2 py-0.5 rounded border bg-emerald-500/10 text-emerald-400 border-emerald-500/30">
          {counts.completed} conseguidos
        </span>
        {counts.expired > 0 && (
          <span className="px-2 py-0.5 rounded border bg-slate-500/10 text-slate-400 border-slate-500/30">
            {counts.expired} a medias
          </span>
        )}
        <span className="px-2 py-0.5 rounded border bg-[#0a0a0c] text-slate-400 border-white/10">
          {totalXp} XP acumulada
        </span>
      </div>

      <p className={clsx('text-[11px]', error ? 'text-rose-400' : 'text-emerald-300')}>
        {error || note || 'Los retos se miden solos con lo que registres en la app: no hay casillas que marcar.'}
      </p>
    </div>
  );
}
