'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Check, Loader2, ShieldAlert, X } from 'lucide-react';
import clsx from 'clsx';
import type { SetupToolApiResponse, SetupToolProposal } from '@/lib/setupToolTypes';

/**
 * La tarjeta de confirmación de una herramienta del coordinador.
 *
 * Se pinta con datos que ya ha validado el servidor (impacto, recuentos,
 * nombres). El cliente NO decide si una acción es posible: solo la confirma.
 * Al pulsar, manda `confirmed: true` y el servidor vuelve a validar la
 * propiedad contra la sesión antes de escribir.
 */

interface SetupToolCardProps {
  proposal: SetupToolProposal;
  /** Se llama con el resultado para apuntarlo en el mensaje del chat. */
  onExecuted: (result: SetupToolApiResponse) => void;
}

export default function SetupToolCard({ proposal, onExecuted }: SetupToolCardProps) {
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'working' | 'done' | 'failed' | 'cancelled'>('idle');
  const [problems, setProblems] = useState<string[]>([]);
  const [applied, setApplied] = useState<string[]>([]);

  const run = async () => {
    if (state === 'working' || state === 'done') return;
    setState('working');
    setProblems([]);

    try {
      const response = await fetch('/api/puesta-a-punto/tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: proposal.tool, input: proposal.input, confirmed: true }),
      });
      const raw = await response.text();
      let data: SetupToolApiResponse | null = null;
      try {
        data = raw.length > 0 ? (JSON.parse(raw) as SetupToolApiResponse) : null;
      } catch {
        data = null;
      }

      if (!data) {
        throw new Error(`El servidor no ha contestado (HTTP ${response.status}). Inténtalo otra vez.`);
      }
      if (!data.ok) {
        setState('failed');
        setProblems(data.problems.length > 0 ? data.problems : ['No se ha cambiado nada.']);
        onExecuted(data);
        return;
      }

      setState('done');
      setApplied(data.applied);
      setProblems(data.problems);
      onExecuted(data);
      // Las vistas de servidor (temario, portada, exámenes) ya están marcadas
      // como obsoletas por la ruta; aquí se vuelven a pedir.
      router.refresh();
    } catch (error) {
      setState('failed');
      setProblems([(error as Error).message]);
    }
  };

  const closed = state === 'done' || state === 'failed' || state === 'cancelled';

  return (
    <div
      className={clsx(
        'rounded-xl border p-3 text-[12px]',
        proposal.destructive
          ? 'border-rose-500/40 bg-rose-500/[0.06]'
          : 'border-emerald-500/40 bg-emerald-500/[0.06]',
        closed && 'opacity-90'
      )}
    >
      <div className="flex items-start gap-2">
        <div
          className={clsx(
            'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border',
            proposal.destructive
              ? 'border-rose-500/40 bg-rose-500/10 text-rose-300'
              : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
          )}
        >
          {proposal.destructive ? <ShieldAlert className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
        </div>

        <div className="min-w-0 flex-1">
          <div className="font-bold text-slate-100">{proposal.title}</div>
          <p className="mt-0.5 text-[11px] leading-relaxed text-slate-400">{proposal.description}</p>

          {proposal.impact.length > 0 && (
            <ul className="mt-2 space-y-1">
              {proposal.impact.map((item, index) => (
                <li key={`${item.label}-${index}`} className="flex gap-1.5 text-[11px] text-slate-300">
                  <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-slate-500" />
                  <span className="min-w-0">
                    <span className="font-medium">{item.label}</span>
                    {item.detail ? <span className="text-slate-500"> · {item.detail}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {proposal.warnings.length > 0 && (
            <div className="mt-2 space-y-1">
              {proposal.warnings.map((warning, index) => (
                <div key={`${warning}-${index}`} className="flex items-start gap-1.5 text-[10px] text-amber-300/90">
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>{warning}</span>
                </div>
              ))}
            </div>
          )}

          {state === 'done' && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {(applied.length > 0 ? applied : ['Hecho']).map((item, index) => (
                <span
                  key={`${item}-${index}`}
                  className="inline-flex items-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300"
                >
                  <Check className="h-2.5 w-2.5" />
                  {item}
                </span>
              ))}
            </div>
          )}

          {(state === 'failed' || (state === 'done' && problems.length > 0)) && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {problems.map((item, index) => (
                <span
                  key={`${item}-${index}`}
                  className="inline-flex items-start gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300"
                >
                  <AlertTriangle className="mt-0.5 h-2.5 w-2.5 shrink-0" />
                  {item}
                </span>
              ))}
            </div>
          )}

          {state !== 'done' && state !== 'cancelled' && (
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={run}
                disabled={state === 'working'}
                className={clsx(
                  'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-bold transition-colors disabled:opacity-60',
                  proposal.destructive
                    ? 'bg-rose-500/90 text-white hover:bg-rose-500'
                    : 'bg-emerald-500/90 text-slate-950 hover:bg-emerald-400'
                )}
              >
                {state === 'working' ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : proposal.destructive ? (
                  <X className="h-3 w-3" />
                ) : (
                  <Check className="h-3 w-3" />
                )}
                {state === 'working' ? 'Aplicando…' : proposal.confirmLabel}
              </button>
              <button
                type="button"
                onClick={() => setState('cancelled')}
                disabled={state === 'working'}
                className="rounded-lg border border-slate-700 px-2.5 py-1.5 text-[11px] font-semibold text-slate-400 hover:border-slate-600 hover:text-slate-200 disabled:opacity-60"
              >
                Cancelar
              </button>
              {state === 'failed' && (
                <button
                  type="button"
                  onClick={run}
                  className="text-[10px] font-semibold text-slate-400 underline hover:text-slate-200"
                >
                  Reintentar
                </button>
              )}
            </div>
          )}

          {state === 'cancelled' && (
            <div className="mt-2 text-[10px] text-slate-500">Cancelado. No se ha cambiado nada.</div>
          )}
        </div>
      </div>
    </div>
  );
}
