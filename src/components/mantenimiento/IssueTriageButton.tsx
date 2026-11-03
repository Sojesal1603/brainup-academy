'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';
import { Bot, CheckCircle2, Eye, Loader2, Sparkles } from 'lucide-react';
import { triageReportedIssues } from '@/lib/maintenanceActions';

/**
 * «Que la IA atienda lo que he reportado».
 *
 * El botón llama a la acción del servidor: la IA lee tus fallos anotados, los
 * empareja con las comprobaciones del taller y con los arreglos que existen, y
 * **arregla lo que ya se considera seguro** (renombrar, renumerar, acotar rangos,
 * quitar una unidad repetida que está vacía). Lo que tocaría datos con valor se
 * queda diagnosticado, con el arreglo a un clic desde el panel de arriba.
 *
 * Esto no es el único camino: el vigilante hace exactamente lo mismo en cada
 * ronda, así que un fallo reportado se atiende aunque no abras esta pantalla.
 */

export interface TriageOutcome {
  id: string;
  title: string;
  status: 'resuelto' | 'revisado';
  fixId: string | null;
  fixLabel: string | null;
  reason: string;
  applied: number;
}

interface TriageState {
  success: boolean;
  error?: string;
  model: string;
  reviewed: number;
  applied: number;
  outcomes: TriageOutcome[];
}

export default function IssueTriageButton({
  pending,
  aiConfigured,
}: {
  pending: number;
  aiConfigured: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [state, setState] = useState<TriageState | null>(null);

  function runTriage() {
    if (isPending) return;
    setState(null);

    startTransition(async () => {
      const response = await triageReportedIssues();
      setState({
        success: response.success,
        error: response.error,
        model: response.model,
        reviewed: response.reviewed,
        applied: response.applied,
        outcomes: response.outcomes,
      });
      router.refresh();
    });
  }

  const statusMeta = {
    resuelto: {
      label: 'arreglado',
      badge: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
    },
    revisado: {
      label: 'diagnosticado',
      badge: 'bg-sky-500/10 text-sky-400 border-sky-500/30',
    },
  } as const;

  return (
    <div className="p-5 rounded-2xl glass-card space-y-3">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-start gap-2">
          <Bot className="w-4 h-4 text-violet-400 mt-0.5" />
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-slate-200">
              Atender lo que has reportado
            </p>
            <p className="text-[11px] text-slate-400 max-w-2xl leading-relaxed">
              La IA lee tus fallos anotados, los cruza con las comprobaciones del taller y con los
              arreglos que existen, y arregla lo que ya es seguro. Lo que tocaría datos con valor te
              lo explica en vez de tocarlo, con el arreglo señalado para que lo apliques arriba.
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={runTriage}
          disabled={isPending || pending === 0}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-violet-500 px-4 py-2.5 text-xs font-bold text-slate-950 transition-all hover:bg-violet-400 disabled:cursor-not-allowed disabled:opacity-50 shrink-0"
        >
          {isPending ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Mirando…</span>
            </>
          ) : (
            <>
              <Sparkles className="w-4 h-4" />
              <span>Revisar {pending > 0 ? `${pending} reporte(s)` : 'mis reportes'}</span>
            </>
          )}
        </button>
      </div>

      {pending === 0 && (
        <p className="text-[11px] text-slate-500">
          No hay nada tuyo sin revisar. Cuando anotes un fallo, aparece aquí para que la IA lo mire
          (o lo mira el vigilante por su cuenta en su siguiente ronda).
        </p>
      )}

      {!aiConfigured && pending > 0 && (
        <p className="text-[11px] text-amber-300/90 leading-relaxed">
          Sin claves de IA (.env → GEMINI_API_KEY o GROQ_API_KEY) solo se puede mirar si hay algo que
          arreglar, sin diagnóstico escrito. El resto del taller funciona igual.
        </p>
      )}

      {state && !state.success && state.error && (
        <div className="p-3 rounded-xl bg-amber-500/5 border border-amber-500/30">
          <p className="text-[11px] text-amber-300 leading-relaxed">{state.error}</p>
        </div>
      )}

      {state?.success && (
        <div className="space-y-2">
          {state.reviewed === 0 ? (
            <p className="text-[11px] text-slate-300 leading-relaxed">
              No había ningún reporte esperando, así que no se ha tocado nada.
            </p>
          ) : (
            <>
              <p className="text-[11px] text-slate-300 leading-relaxed">
                {state.reviewed} reporte(s) revisado(s)
                {state.applied > 0 ? ` · ${state.applied} cambio(s) aplicado(s)` : ' · ningún cambio automático'}
                {state.model ? ` · ${state.model}` : ''}
              </p>

              <div className="rounded-xl border border-white/10 divide-y divide-[#1e293b] overflow-hidden">
                {state.outcomes.map((outcome) => {
                  const meta = statusMeta[outcome.status];
                  return (
                    <div key={outcome.id} className="p-3 bg-[#0a1120] space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={clsx(
                            'text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded border',
                            meta.badge
                          )}
                        >
                          {meta.label}
                        </span>
                        {outcome.status === 'resuelto' ? (
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                        ) : (
                          <Eye className="w-3.5 h-3.5 text-sky-400" />
                        )}
                        <span className="text-[11px] font-semibold text-slate-100">{outcome.title}</span>
                      </div>
                      <p className="text-[11px] text-slate-400 leading-relaxed">{outcome.reason}</p>
                      {outcome.fixLabel && (
                        <p className="text-[10px] font-mono text-emerald-300/90">
                          arreglo: {outcome.fixId} · {outcome.fixLabel}
                          {outcome.applied > 0 ? ` (${outcome.applied})` : ' (sin aplicar)'}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
