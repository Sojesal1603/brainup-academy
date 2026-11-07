'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Lock,
  Moon,
  ShieldAlert,
} from 'lucide-react';
import type { NightCloseState } from '@/lib/nightClose';

interface PendingBlock {
  id: string;
  subject: string;
  subjectColor: string;
  topic: string;
  minutes: number;
  status: string;
  technique: string;
}

interface NightResponse {
  ok?: boolean;
  state?: NightCloseState;
  closed?: boolean;
  pending?: PendingBlock[];
  message?: string;
  error?: string;
}

/**
 * Auditoría de cierre de la jornada.
 *
 * A partir de las 21:00, si quedan tareas obligatorias el día queda bloqueado:
 * «Cerrar el día» no funciona hasta que no quede nada. La única salida es
 * aplazar con una razón real, y eso devuelve lo pendiente con +25 de prioridad.
 */
export default function NightCloseCard() {
  const router = useRouter();
  const [data, setData] = useState<NightResponse | null>(null);
  const [justification, setJustification] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/planner/night', { cache: 'no-store' });
      const payload = (await res.json().catch(() => null)) as NightResponse | null;
      if (!res.ok || !payload?.state) {
        setError(payload?.error || 'No se ha podido leer el cierre del día.');
        return;
      }
      setData(payload);
      setError(null);
    } catch {
      setError('No se ha podido leer el cierre del día.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async (action: 'cerrar' | 'aplazar') => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    setNotice(null);

    try {
      const res = await fetch('/api/planner/night', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, justification }),
      });
      const payload = (await res.json().catch(() => null)) as NightResponse | null;

      if (!res.ok || !payload) {
        setError(payload?.error || 'No se ha podido cerrar el día.');
        if (payload?.pending) {
          setData((previous) =>
            previous && payload.state
              ? { ...previous, state: payload.state, pending: payload.pending }
              : previous
          );
        }
        return;
      }

      setData((previous) =>
        previous && payload.state
          ? { ...previous, ...payload, state: payload.state }
          : previous
      );
      setNotice(
        payload.message ||
          (action === 'cerrar'
            ? 'Día cerrado sin tareas pendientes.'
            : 'Lo pendiente se ha reprogramado con penalización.')
      );
      setJustification('');
      router.refresh();
    } catch {
      setError('Fallo de red al cerrar el día. Vuelve a intentarlo.');
    } finally {
      setSubmitting(false);
    }
  };

  if (!data?.state) return null;
  // De día no se pinta nada: el cierre solo existe cuando toca.
  if (data.state.phase === 'dia' && !data.closed) return null;

  const { state, pending = [] } = data;
  const locked = state.locked;
  const canJustify = justification.trim().length >= state.minJustification;

  return (
    <div
      className={`glass-card space-y-3 rounded-2xl border p-4 ${
        locked ? 'border-rose-500/30' : 'border-emerald-500/25'
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-slate-300">
          {locked ? (
            <Lock className="h-4 w-4 text-rose-400" />
          ) : state.phase === 'cerrado' ? (
            <CheckCircle2 className="h-4 w-4 text-emerald-400" />
          ) : (
            <Moon className="h-4 w-4 text-cyan-300" />
          )}
          Cierre de la jornada
        </h2>
        <span
          className={`rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider ${
            locked
              ? 'border-rose-500/40 bg-rose-500/10 text-rose-300'
              : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
          }`}
        >
          {state.phase === 'cerrado' ? 'cerrado' : locked ? 'bloqueado' : 'se puede cerrar'}
        </span>
      </div>

      <p className={`text-[12px] leading-relaxed ${locked ? 'text-rose-200' : 'text-slate-300'}`}>
        {state.message}
      </p>

      {locked && pending.length > 0 && (
        <div className="space-y-1">
          {pending.map((block) => (
            <div
              key={block.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-1.5"
            >
              <span className="min-w-0 truncate text-[11px] text-slate-300">
                <span style={{ color: block.subjectColor }}>{block.subject}</span>:{' '}
                {block.topic}
              </span>
              <span className="shrink-0 font-mono text-[10px] text-slate-500">
                {block.minutes} min · {block.status.replace('_', ' ')}
              </span>
            </div>
          ))}
        </div>
      )}

      {locked && (
        <div className="space-y-2">
          <label className="block text-[10px] font-mono uppercase tracking-wider text-slate-500">
            Razón para aplazar (mínimo {state.minJustification} caracteres)
          </label>
          <textarea
            value={justification}
            onChange={(event) => setJustification(event.target.value)}
            rows={2}
            maxLength={400}
            placeholder="Qué ha pasado y cómo lo vas a recuperar mañana…"
            className="w-full resize-none rounded-lg border border-slate-800 bg-[#070b14] px-3 py-2 text-xs text-slate-200 transition-colors placeholder:text-slate-600 focus:border-rose-500/50 focus:outline-none focus:ring-1 focus:ring-rose-500/30"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void submit('aplazar')}
              disabled={submitting || !canJustify}
              className="flex items-center gap-1.5 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-[11px] font-semibold text-rose-200 transition-colors hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-40"
              title={`Lo pendiente vuelve mañana con +${state.penaltyPoints} de prioridad`}
            >
              {submitting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ShieldAlert className="h-3.5 w-3.5" />
              )}
              Aplazar con +{state.penaltyPoints} de prioridad
            </button>
            <span className="font-mono text-[9px] text-slate-600">
              {justification.trim().length}/{state.minJustification}
            </span>
          </div>
        </div>
      )}

      {!locked && state.phase !== 'cerrado' && (
        <button
          type="button"
          onClick={() => void submit('cerrar')}
          disabled={submitting}
          className="flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-[11px] font-bold text-slate-950 transition-colors hover:bg-emerald-400 disabled:opacity-50"
        >
          {submitting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5" />
          )}
          Cerrar el día
        </button>
      )}

      {notice && <p className="text-[11px] text-emerald-300">{notice}</p>}
      {error && (
        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-rose-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}
