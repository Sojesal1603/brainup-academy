'use client';

import NeuralLoader from '@/components/ui/NeuralLoader';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Play } from 'lucide-react';
import { EBAU_COMMUNITIES } from '@/lib/ebauCommunities';

/**
 * Lanza un simulacro EBAU con la estructura de la comunidad elegida. La
 * comunidad se guarda en el perfil al arrancar, así el siguiente examen sale
 * con la misma configuración.
 */
export default function StartSimulacroButton({
  subjectId,
  subjectName,
  defaultCommunity,
  disabled,
}: {
  subjectId: string;
  subjectName: string;
  defaultCommunity: string;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [community, setCommunity] = useState(defaultCommunity);
  const [error, setError] = useState('');

  async function start() {
    if (loading) return;
    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/examinador/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subjectId, community }),
      });
      const data = (await res.json().catch(() => null)) as
        | { sessionId?: string; error?: string }
        | null;

      if (!res.ok || !data?.sessionId) {
        throw new Error(data?.error || `No se pudo generar el simulacro de ${subjectName}.`);
      }

      router.push(`/examinador/${data.sessionId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error inesperado al generar el simulacro.');
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2">
      <label className="block text-[10px] font-semibold uppercase tracking-wider text-slate-500">
        Comunidad del examen
      </label>
      <select
        value={community}
        onChange={(event) => setCommunity(event.target.value)}
        disabled={loading}
        className="w-full rounded-lg border border-slate-800 bg-[#070b14] px-2.5 py-2 text-[11px] text-slate-200 focus:border-emerald-500 focus:outline-none disabled:opacity-60"
      >
        {EBAU_COMMUNITIES.map((option) => (
          <option key={option.code} value={option.code}>
            {option.name} · {option.durationMinutes} min
          </option>
        ))}
      </select>

      <button
        type="button"
        onClick={() => void start()}
        disabled={loading || disabled}
        title={disabled ? 'Añade temas a esta asignatura para generar simulacros' : undefined}
        className="w-full flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 disabled:hover:bg-emerald-500 disabled:cursor-not-allowed text-slate-950 text-xs font-bold transition-all shadow-md hover:scale-105 disabled:hover:scale-100"
      >
        {loading ? (
          <>
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span>Generando simulacro…</span>
          </>
        ) : (
          <>
            <Play className="w-3.5 h-3.5 fill-slate-950" />
            <span>Iniciar Simulacro Cronometrado</span>
          </>
        )}
      </button>

      {loading && (
        <NeuralLoader
          compact
          title="Generando el simulacro"
          messages={[
            'Aplicando la estructura de tu comunidad...',
            'Cruzando el temario con los criterios de tu centro...',
            'Calibrando dificultad, apartados y notación...',
          ]}
        />
      )}

      {error && <p className="text-[11px] text-rose-400 text-center">{error}</p>}
    </div>
  );
}
