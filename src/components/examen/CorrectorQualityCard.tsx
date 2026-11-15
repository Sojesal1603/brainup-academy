'use client';

import { useState } from 'react';
import { Activity, Loader2, RefreshCw } from 'lucide-react';
import type { EvalRun } from '@/lib/evalBank';

/**
 * Calidad medida del corrector: error absoluto medio contra el banco de casos
 * con nota puesta a mano. Muestra números, no una promesa.
 */
export default function CorrectorQualityCard({ initial }: { initial: EvalRun | null }) {
  const [run, setRun] = useState<EvalRun | null>(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function measure() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/examinador/evaluacion', { method: 'POST' });
      const body = (await res.json()) as { ok?: boolean; run?: EvalRun; error?: string };
      if (!res.ok || !body.ok || !body.run) {
        throw new Error(body.error ?? `El servidor respondió ${res.status}`);
      }
      setRun(body.run);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se ha podido medir.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="p-4 rounded-2xl bg-[#080d18] border border-slate-800">
      <div className="flex items-center justify-between gap-3 mb-2">
        <p className="text-[10px] font-mono uppercase tracking-widest text-slate-500 flex items-center gap-1.5">
          <Activity className="w-3.5 h-3.5" /> Calidad del corrector
        </p>
        <button
          type="button"
          onClick={measure}
          disabled={loading}
          className="text-[10px] font-bold px-2.5 py-1 rounded-lg border border-slate-700 text-slate-300 hover:border-emerald-500/50 hover:text-emerald-300 disabled:opacity-50 flex items-center gap-1"
        >
          {loading ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <RefreshCw className="w-3 h-3" />
          )}
          {loading ? 'Midiendo…' : 'Medir ahora'}
        </button>
      </div>

      {run ? (
        <>
          <p className="text-xs text-slate-300">
            Error absoluto medio:{' '}
            <span className="font-black font-mono text-emerald-300">
              {run.summary.mae.toFixed(2).replace('.', ',')} pts
            </span>{' '}
            sobre {run.summary.cases} caso(s) ·{' '}
            {run.passes === 1 ? '1 pasada (la 2.ª falló)' : `${run.passes} pasadas, mediana`}
          </p>
          <div className="mt-2 grid gap-1">
            {run.summary.bySubject.map((group) => (
              <p key={group.label} className="text-[10px] text-slate-500 font-mono">
                {group.label} · {group.cases} caso(s) · MAE {group.mae.toFixed(2).replace('.', ',')}
              </p>
            ))}
          </div>
          <p className="text-[10px] text-slate-600 mt-2">
            Última medición: {new Date(run.ranAt).toLocaleString('es-ES')} ·{' '}
            {run.model ?? 'modelo desconocido'}. Mide al corrector, no al alumno.
          </p>
        </>
      ) : (
        <p className="text-[11px] text-slate-500">
          Aún no se ha medido el corrector contra el banco de referencia. Pulsa «Medir ahora»
          (tarda unos minutos: cada caso se corrige dos veces).
        </p>
      )}

      {error && <p className="text-[11px] text-rose-400 mt-2">{error}</p>}
    </div>
  );
}
