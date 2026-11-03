'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  CheckCircle2,
  Loader2,
  RefreshCw,
  TriangleAlert,
  Link2,
} from 'lucide-react';
import clsx from 'clsx';

interface MoodleConnectorProps {
  initialUrl: string;
  lastSyncIso: string | null;
}

export default function MoodleConnector({ initialUrl, lastSyncIso }: MoodleConnectorProps) {
  const router = useRouter();
  const [url, setUrl] = useState(initialUrl);
  const [status, setStatus] = useState<'idle' | 'working' | 'ok' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [lastSync, setLastSync] = useState<string | null>(lastSyncIso);

  const handleSync = async () => {
    if (status === 'working') return;
    setStatus('working');
    setMessage('');

    try {
      const res = await fetch('/api/moodle/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim() }),
      });

      const data = (await res.json().catch(() => null)) as
        | {
            ok?: boolean;
            stats?: { total: number; created: number; updated: number; skipped: number };
            lastSync?: string;
            error?: string;
          }
        | null;

      if (!res.ok || data?.error || !data?.stats) {
        throw new Error(data?.error || 'Error al sincronizar con Moodle.');
      }

      setStatus('ok');
      setMessage(
        `Sincronización completada: ${data.stats.created} tareas nuevas, ${data.stats.updated} actualizadas (${data.stats.total} eventos leídos).`
      );
      if (data.lastSync) setLastSync(data.lastSync);
      router.refresh();
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'Error inesperado.');
    }
  };

  const formattedLastSync = lastSync
    ? new Date(lastSync).toLocaleString('es-ES', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          Enlace de suscripción iCal de tu Moodle
        </label>
        <div className="flex flex-col sm:flex-row gap-2.5">
          <div className="relative flex-1">
            <Link2 className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://moodle.tuinstituto.es/calendar/export_execute.php?..."
              className="w-full bg-[#080d18] border border-slate-800 rounded-xl pl-9 pr-3 py-2.5 text-xs text-slate-200 focus:outline-none focus:border-emerald-500 font-mono"
            />
          </div>
          <button
            onClick={handleSync}
            disabled={status === 'working' || url.trim().length === 0}
            className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold transition-all disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
          >
            {status === 'working' ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4" />
            )}
            <span>Guardar y sincronizar</span>
          </button>
        </div>
        <p className="text-[11px] text-slate-500 leading-relaxed">
          En Moodle: <strong className="text-slate-400">Calendario → Exportar calendario → URL de
          suscripción</strong>. Pega ese enlace aquí una sola vez: BrainUp leerá las entregas y
          exámenes nuevos y los añadirá al Cuartel sin duplicados.
        </p>
      </div>

      {message && (
        <div
          className={clsx(
            'flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-xs leading-relaxed',
            status === 'ok'
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
              : 'border-rose-500/30 bg-rose-500/10 text-rose-200'
          )}
        >
          {status === 'ok' ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
          ) : (
            <TriangleAlert className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
          )}
          <span>{message}</span>
        </div>
      )}

      <div className="flex items-center gap-2 text-[11px] text-slate-500 font-mono">
        <span className="inline-block w-2 h-2 rounded-full bg-emerald-400/80" />
        {formattedLastSync
          ? `Última sincronización: ${formattedLastSync}`
          : 'Sin sincronizar todavía'}
      </div>
    </div>
  );
}
