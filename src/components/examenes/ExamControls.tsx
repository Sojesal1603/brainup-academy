'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarClock, Check, Loader2, Trash2, Undo2, X } from 'lucide-react';
import { deleteExam, toggleExamCompleted, updateExam } from '@/lib/actions';

interface ExamControlsProps {
  examId: string;
  /** Fecha actual del examen en formato `AAAA-MM-DD` (la del `<input type=date>`). */
  examDate: string;
  isCompleted: boolean;
}

function todayIso(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Las tres cosas que se pueden hacer con un examen ya apuntado: cambiarle la
 * fecha, darlo por hecho y borrarlo.
 *
 * Antes no se podía ninguna: el gestor solo sabía crear. Así, un examen con la
 * fecha equivocada —o que el alumno dijo que no existía— se quedaba ahí para
 * siempre, ensuciando la cuenta atrás y el plan del día.
 */
export default function ExamControls({ examId, examDate, isCompleted }: ExamControlsProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [mode, setMode] = useState<'idle' | 'date' | 'confirm-delete'>('idle');
  const [date, setDate] = useState(examDate);
  const [error, setError] = useState<string | null>(null);

  const run = (action: () => Promise<{ success: boolean; error?: string }>) => {
    startTransition(async () => {
      const result = await action();
      if (!result.success) {
        setError(result.error ?? 'No se ha podido hacer el cambio.');
        return;
      }
      setError(null);
      setMode('idle');
      router.refresh();
    });
  };

  if (mode === 'date') {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-white/10 bg-[#0a0a0c] px-3 py-2">
        <CalendarClock className="h-3.5 w-3.5 shrink-0 text-slate-400" />
        <input
          type="date"
          value={date}
          min="2000-01-01"
          onChange={(e) => setDate(e.target.value)}
          className="rounded-lg glass-card px-2 py-1 font-mono text-xs text-slate-100 outline-none focus:border-emerald-500/60"
        />
        <button
          type="button"
          disabled={pending || date === examDate}
          onClick={() => run(() => updateExam(examId, { examDate: date }))}
          className="flex items-center gap-1 rounded-lg bg-emerald-500 px-2.5 py-1 text-[11px] font-bold text-slate-950 transition-all hover:bg-emerald-400 disabled:opacity-40"
        >
          {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
          Guardar fecha
        </button>
        <button
          type="button"
          onClick={() => {
            setDate(examDate);
            setMode('idle');
            setError(null);
          }}
          className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium text-slate-400 hover:text-slate-200"
        >
          <X className="h-3 w-3" />
          Cancelar
        </button>
        {error && <span className="text-[11px] text-rose-400">{error}</span>}
      </div>
    );
  }

  if (mode === 'confirm-delete') {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-rose-500/40 bg-rose-500/5 px-3 py-2">
        <span className="text-[11px] font-semibold text-rose-300">
          ¿Quitar este examen? Si tenía simulacros, se quedan guardados.
        </span>
        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => deleteExam(examId))}
          className="flex items-center gap-1 rounded-lg bg-rose-500 px-2.5 py-1 text-[11px] font-bold text-slate-950 transition-all hover:bg-rose-400 disabled:opacity-40"
        >
          {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
          Sí, quitar
        </button>
        <button
          type="button"
          onClick={() => setMode('idle')}
          className="rounded-lg px-2 py-1 text-[11px] font-medium text-slate-400 hover:text-slate-200"
        >
          No
        </button>
        {error && <span className="text-[11px] text-rose-400">{error}</span>}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => setMode('date')}
        title="El profesor ha movido la fecha"
        className="flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800/70 px-3 py-2 text-xs font-semibold text-slate-200 transition-all hover:border-slate-600 hover:bg-slate-700/70"
      >
        <CalendarClock className="h-3.5 w-3.5 text-amber-400" />
        <span>Cambiar fecha</span>
      </button>

      <button
        type="button"
        disabled={pending}
        onClick={() => run(() => toggleExamCompleted(examId))}
        title={isCompleted ? 'Volver a marcarlo como pendiente' : 'Ya lo he hecho'}
        className="flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800/70 px-3 py-2 text-xs font-semibold text-slate-200 transition-all hover:border-slate-600 hover:bg-slate-700/70 disabled:opacity-40"
      >
        {pending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : isCompleted ? (
          <Undo2 className="h-3.5 w-3.5 text-slate-400" />
        ) : (
          <Check className="h-3.5 w-3.5 text-emerald-400" />
        )}
        <span>{isCompleted ? 'Reabrir' : 'Hecho'}</span>
      </button>

      <button
        type="button"
        onClick={() => setMode('confirm-delete')}
        title="Ese examen no existe o ya no cuenta"
        className="flex items-center gap-1.5 rounded-xl border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-xs font-semibold text-rose-300 transition-all hover:border-rose-500/60 hover:bg-rose-500/10"
      >
        <Trash2 className="h-3.5 w-3.5" />
        <span>Quitar</span>
      </button>
    </div>
  );
}

/** Fecha local de hoy en `AAAA-MM-DD`; la usa el gestor para los valores de partida. */
export { todayIso };
