'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';
import { AlertTriangle, CheckCircle2, Loader2, ShieldCheck, Wrench } from 'lucide-react';
import { applyMaintenanceFixes } from '@/lib/maintenanceActions';

/**
 * Los arreglos del taller.
 *
 * Cada botón dice **qué va a cambiar** antes de pulsarlo (label + descripción +
 * cuántos casos), y los que no están marcados como seguros se distinguen y
 * avisan de que hay que leerlos. Después del clic se cuenta lo que ha pasado de
 * verdad: cuántos casos se han tocado y cuántos hallazgos quedan.
 */

export interface FixSummary {
  id: string;
  label: string;
  description: string;
  count: number;
  safe: boolean;
}

interface FixesPanelProps {
  fixes: FixSummary[];
  /** Sin hallazgos: no hay nada que arreglar. */
  clean: boolean;
  /** Cuántos hallazgos hay ahora mismo (para poder decir «quedan N»). */
  findings: number;
}

interface ApplyResult {
  applied: Array<{ id: string; label: string; count: number }>;
  problems: string[];
  remaining: number;
}

export default function FixesPanel({ fixes, clean, findings }: FixesPanelProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [error, setError] = useState('');

  const safeFixes = fixes.filter((fix) => fix.safe);
  const reviewFixes = fixes.filter((fix) => !fix.safe);

  function apply(ids?: string[], busy: string = 'all') {
    if (isPending) return;
    setError('');
    setResult(null);
    setBusyId(busy);

    startTransition(async () => {
      const response = await applyMaintenanceFixes(ids);

      if (!response.success) {
        setError(response.error ?? 'No se han podido aplicar los arreglos.');
        setBusyId(null);
        return;
      }

      setResult({
        applied: response.applied,
        problems: response.problems,
        remaining: response.remaining,
      });
      setBusyId(null);
      router.refresh();
    });
  }

  return (
    <div className="p-5 rounded-2xl glass-card space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Wrench className="w-4 h-4 text-emerald-400" />
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-slate-200">
              Arreglos disponibles
            </p>
            <p className="text-[11px] text-slate-400">
              Se aplican sobre la base de datos. Lo que borra algo avisa antes y nunca toca filas con
              datos colgando.
            </p>
          </div>
        </div>

        {safeFixes.length > 0 && (
          <button
            type="button"
            onClick={() => apply(undefined, 'all')}
            disabled={isPending}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-500 px-4 py-2.5 text-xs font-bold text-slate-950 transition-all hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isPending && busyId === 'all' ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Arreglando…</span>
              </>
            ) : (
              <>
                <ShieldCheck className="w-4 h-4" />
                <span>Arreglar todo lo seguro ({safeFixes.length})</span>
              </>
            )}
          </button>
        )}
      </div>

      {clean ? (
        <div className="p-4 rounded-xl bg-emerald-500/5 border border-emerald-500/30 flex items-start gap-3">
          <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
          <div>
            <p className="text-xs font-bold text-emerald-300">El sistema no tiene nada roto</p>
            <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
              Las comprobaciones han pasado todas. El vigilante («npm run vigilante») sigue mirando
              por su cuenta y vuelve a pasarlas cada pocos minutos.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {fixes.map((fix) => (
            <div
              key={fix.id}
              className={clsx(
                'p-4 rounded-xl border space-y-2',
                fix.safe ? 'bg-[#0a1120] border-white/10' : 'bg-amber-500/5 border-amber-500/30'
              )}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={clsx(
                    'text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded border',
                    fix.safe
                      ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                      : 'bg-amber-500/10 text-amber-400 border-amber-500/30'
                  )}
                >
                  {fix.safe ? 'seguro' : 'revisar'}
                </span>
                <span className="text-xs font-bold text-slate-100">{fix.label}</span>
                <span className="text-[11px] font-mono text-slate-500">{fix.count} caso(s)</span>
              </div>

              <p className="text-[11px] text-slate-400 leading-relaxed">{fix.description}</p>

              {!fix.safe && (
                <p className="text-[11px] text-amber-300/90 flex items-start gap-1.5 leading-relaxed">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>
                    Este arreglo cambia cosas que quizá quieras revisar antes (por ejemplo, cerrar
                    exámenes que ya pasaron). No se aplica solo.
                  </span>
                </p>
              )}

              <button
                type="button"
                onClick={() => apply([fix.id], fix.id)}
                disabled={isPending}
                className={clsx(
                  'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-semibold transition-all disabled:opacity-50',
                  fix.safe
                    ? 'bg-slate-800 text-slate-200 border border-slate-700 hover:bg-slate-700'
                    : 'bg-amber-500/15 text-amber-300 border border-amber-500/40 hover:bg-amber-500/25'
                )}
              >
                {isPending && busyId === fix.id ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Aplicando…</span>
                  </>
                ) : (
                  <span>Aplicar este arreglo</span>
                )}
              </button>
            </div>
          ))}

          {reviewFixes.length > 0 && safeFixes.length === 0 && (
            <p className="text-[11px] text-slate-500">
              Ahora mismo solo hay arreglos que conviene mirar antes: no se aplica ninguno solo.
            </p>
          )}
        </div>
      )}

      {error && <p className="text-[11px] text-rose-400 leading-relaxed">{error}</p>}

      {result && (
        <div className="p-4 rounded-xl bg-[#0a1120] border border-white/10 space-y-1.5">
          <p className="text-xs font-bold text-slate-200">Lo que ha cambiado</p>
          {result.applied.length === 0 ? (
            <p className="text-[11px] text-slate-400">
              Ningún caso que arreglar: los hallazgos que quedan no tienen arreglo automático.
            </p>
          ) : (
            <ul className="space-y-0.5">
              {result.applied.map((item) => (
                <li key={item.id} className="text-[11px] font-mono text-emerald-300">
                  ✓ {item.label} · {item.count} caso(s)
                </li>
              ))}
            </ul>
          )}
          <p className="text-[11px] text-slate-400">
            {result.remaining === 0
              ? 'Ya no queda ningún hallazgo: el sistema ha quedado limpio.'
              : `Quedan ${result.remaining} hallazgo(s) tras esta pasada (de ${findings} antes de arreglar).`}
          </p>
          {result.problems.length > 0 && (
            <div className="pt-1 space-y-0.5">
              <p className="text-[11px] text-amber-300">Avisos de la pasada:</p>
              {result.problems.map((problem, index) => (
                <p key={index} className="text-[11px] text-amber-300/80 font-mono">
                  {problem}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
