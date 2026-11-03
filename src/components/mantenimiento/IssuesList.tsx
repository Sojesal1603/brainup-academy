'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';
import { CheckCircle2, Eye, Loader2, Zap } from 'lucide-react';
import { updateIssueStatus } from '@/lib/maintenanceActions';

/**
 * Los fallos anotados.
 *
 * El estado es lo que decide si el taller sigue quejándose: una incidencia
 * «abierta» aparece como hallazgo («Fallos reportados sin revisar»). Cuando se
 * marca «resuelta» se puede dejar escrito qué se hizo, y esa nota se guarda.
 */

export interface IssueRow {
  id: string;
  title: string;
  detail: string | null;
  source: string;
  status: string;
  resolution: string | null;
  /** Ya formateada en el servidor (así no hay dos horas distintas al hidratar). */
  createdAtLabel: string;
}

const SOURCE_META: Record<string, { label: string; badgeColor: string }> = {
  alumno: { label: 'alumno', badgeColor: 'bg-rose-500/10 text-rose-400 border-rose-500/30' },
  vigilante: { label: 'vigilante', badgeColor: 'bg-sky-500/10 text-sky-400 border-sky-500/30' },
  ia: { label: 'IA', badgeColor: 'bg-violet-500/10 text-violet-400 border-violet-500/30' },
};

const STATUS_META: Record<string, { label: string; badgeColor: string }> = {
  abierto: { label: 'abierto', badgeColor: 'bg-amber-500/10 text-amber-400 border-amber-500/30' },
  revisado: { label: 'revisado', badgeColor: 'bg-sky-500/10 text-sky-400 border-sky-500/30' },
  resuelto: { label: 'resuelto', badgeColor: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' },
};

export default function IssuesList({ issues }: { issues: IssueRow[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [resolutions, setResolutions] = useState<Record<string, string>>({});

  function changeStatus(id: string, status: 'abierto' | 'revisado' | 'resuelto') {
    if (isPending) return;
    setError('');
    setBusyId(id);

    startTransition(async () => {
      const response = await updateIssueStatus({
        id,
        status,
        resolution: status === 'resuelto' ? resolutions[id] ?? undefined : undefined,
      });

      setBusyId(null);

      if (!response.success) {
        setError(response.error ?? 'No se ha podido cambiar el estado.');
        return;
      }

      router.refresh();
    });
  }

  if (issues.length === 0) {
    return (
      <div className="p-6 rounded-2xl glass-card border border-dashed border-white/10 text-center space-y-1">
        <CheckCircle2 className="w-8 h-8 text-emerald-400 mx-auto" />
        <p className="text-xs font-bold text-slate-200">No hay ningún fallo anotado</p>
        <p className="text-[11px] text-slate-500">
          Cuando la app te falle algo —una pantalla en blanco, un dato raro, un error al guardar—,
          anótalo arriba y queda aquí para revisarlo.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {error && <p className="text-[11px] text-rose-400">{error}</p>}

      {issues.map((issue) => {
        const source = SOURCE_META[issue.source] ?? SOURCE_META.alumno;
        const status = STATUS_META[issue.status] ?? STATUS_META.abierto;
        const busy = isPending && busyId === issue.id;

        return (
          <div key={issue.id} className="glass-card p-4 rounded-2xl space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={clsx(
                  'text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded border',
                  source.badgeColor
                )}
              >
                {source.label}
              </span>
              <span
                className={clsx(
                  'text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded border',
                  status.badgeColor
                )}
              >
                {status.label}
              </span>
              <span className="text-[11px] font-mono text-slate-500">{issue.createdAtLabel}</span>
            </div>

            <p className="text-xs font-bold text-slate-100">{issue.title}</p>
            {issue.detail && (
              <p className="text-[11px] text-slate-400 leading-relaxed whitespace-pre-line">
                {issue.detail}
              </p>
            )}
            {issue.resolution && (
              <p className="text-[11px] text-emerald-300/90 leading-relaxed">
                Resolución: {issue.resolution}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2 pt-1">
              {issue.status !== 'resuelto' && (
                <input
                  type="text"
                  value={resolutions[issue.id] ?? ''}
                  onChange={(event) =>
                    setResolutions((prev) => ({ ...prev, [issue.id]: event.target.value }))
                  }
                  placeholder="Qué se ha hecho con este fallo (opcional)"
                  className="flex-1 min-w-[200px] bg-[#080d18] border border-slate-800 rounded-lg px-3 py-1.5 text-[11px] text-slate-200 focus:outline-none focus:border-emerald-500"
                />
              )}

              {issue.status === 'abierto' && (
                <button
                  type="button"
                  onClick={() => changeStatus(issue.id, 'revisado')}
                  disabled={isPending}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-slate-800 px-3 py-1.5 text-[11px] font-semibold text-slate-200 border border-slate-700 hover:bg-slate-700 disabled:opacity-50"
                >
                  {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />}
                  <span>Lo estoy mirando</span>
                </button>
              )}

              {issue.status !== 'resuelto' && (
                <button
                  type="button"
                  onClick={() => changeStatus(issue.id, 'resuelto')}
                  disabled={isPending}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-[11px] font-bold text-slate-950 hover:bg-emerald-400 disabled:opacity-50"
                >
                  {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                  <span>Resuelto</span>
                </button>
              )}

              {issue.status === 'resuelto' && (
                <button
                  type="button"
                  onClick={() => changeStatus(issue.id, 'abierto')}
                  disabled={isPending}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-slate-800 px-3 py-1.5 text-[11px] font-semibold text-slate-300 border border-slate-700 hover:bg-slate-700 disabled:opacity-50"
                >
                  <Zap className="w-3.5 h-3.5" />
                  <span>Volver a abrirlo</span>
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
