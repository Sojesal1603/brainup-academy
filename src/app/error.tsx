'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, RefreshCw, Stethoscope, Wrench } from 'lucide-react';
import { reportClientError } from '@/lib/clientErrors';

/**
 * Cuando una vista se rompe, esto es lo que se ve.
 *
 * En producción React sustituye el mensaje del servidor por el #441 («An error
 * occurred in the Server Components render») y solo deja un digest: la pantalla
 * no dice nada útil y el fallo parece de la app entera. Como en esta app todas
 * las vistas leen de PostgreSQL (Supabase), el sospechoso habitual es la base:
 * aquí se pregunta a `/api/salud` y, si la base no responde, se enseña el motivo
 * real y qué hacer, en lugar de mandar al alumno a reintentar a ciegas.
 *
 * No promete que se arregle solo: dice qué pasa y dónde mirarlo.
 */

interface DatabaseState {
  ok: boolean;
  code?: string;
  detail?: string;
  hint?: string;
}

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  /** Motivo real de la base, si el parte de salud lo puede decir. */
  const [database, setDatabase] = useState<DatabaseState | null>(null);

  useEffect(() => {
    // Queda en la consola del servidor con su digest: el vigilante y el taller
    // tienen por dónde tirar del hilo.
    console.error('[vista] error de render:', error.message, error.digest ?? '');
    // Y se manda al registro del servidor: sin esto, el fallo solo existía en la
    // consola del navegador y el taller de mantenimiento nunca se enteraba.
    reportClientError({
      message: error.message,
      stack: error.stack,
      digest: error.digest,
      source: 'error.tsx',
      url: typeof window !== 'undefined' ? window.location.pathname : undefined,
    });

    // El parte de salud nunca devuelve 500: si la base está caída, contesta
    // 200 con `.ok: false` y el motivo. Aquí convierte un #441 opaco en algo
    // accionable. Si la llamada falla, no pasa nada: se queda el texto genérico.
    let alive = true;
    fetch('/api/salud', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { database?: DatabaseState } | null) => {
        if (!alive) return;
        if (data?.database && data.database.ok === false) setDatabase(data.database);
      })
      .catch(() => {
        /* sin red o sin endpoint: se queda el mensaje genérico */
      });

    return () => {
      alive = false;
    };
  }, [error]);

  return (
    <div className="min-h-[60vh] flex items-center justify-center p-6">
      <div className="w-full max-w-lg space-y-4 rounded-3xl border border-amber-500/30 glass-card p-6">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-5 h-5 text-amber-400" />
          <h1 className="text-sm font-bold uppercase tracking-wider text-slate-100 font-mono">
            Esta vista no ha podido pintarse
          </h1>
        </div>

        {database ? (
          <>
            <p className="text-xs text-slate-300 leading-relaxed">
              El servidor no ha podido leer la base de datos, así que la vista se ha quedado sin
              datos. <strong className="text-slate-100">No se ha perdido nada</strong>: lo que
              había sigue guardado.
            </p>
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-amber-300">
                {database.code ? `Error ${database.code}` : 'Base de datos sin conexión'}
              </p>
              {database.hint && (
                <p className="mt-1 text-[11px] leading-relaxed text-amber-100/90">{database.hint}</p>
              )}
              {database.detail && (
                <p className="mt-1 break-words font-mono text-[10px] text-amber-200/70">
                  {database.detail.slice(0, 220)}
                </p>
              )}
            </div>
          </>
        ) : (
          <p className="text-xs text-slate-300 leading-relaxed">
            El resto de la app sigue funcionando (tus datos están en la base, no se ha perdido
            nada). En producción React oculta el motivo y solo deja la referencia; dale a{' '}
            <strong className="text-slate-100">Reintentar</strong> o mira el diagnóstico.
          </p>
        )}

        <p className="text-[11px] text-slate-500 font-mono break-words">
          {error.digest ? `referencia ${error.digest} · ` : ''}
          {(error.message || 'Error sin mensaje').slice(0, 180)}
        </p>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={reset}
            className="inline-flex items-center gap-2 rounded-xl bg-emerald-500 px-4 py-2.5 text-xs font-bold text-slate-950 transition-all hover:bg-emerald-400"
          >
            <RefreshCw className="w-4 h-4" />
            <span>Reintentar</span>
          </button>

          <Link
            href="/diagnostico"
            className="inline-flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs font-semibold text-amber-300 transition-all hover:bg-amber-500/20"
          >
            <Stethoscope className="w-4 h-4" />
            <span>Ver diagnóstico</span>
          </Link>

          <Link
            href="/"
            className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-[#0a0a0c] px-4 py-2.5 text-xs font-semibold text-slate-200 transition-all hover:bg-[#111827]"
          >
            <span>Volver al Cuartel</span>
          </Link>
        </div>

        <p className="text-[11px] text-slate-500 leading-relaxed">
          Si vuelve a pasar, cuéntalo en <strong className="text-slate-300">/mantenimiento</strong> (qué
          estabas haciendo y qué esperabas): queda registrado con su contexto y el vigilante lo revisa en
          la siguiente pasada.
        </p>

        <p className="flex items-start gap-2 text-[11px] text-slate-500 leading-relaxed">
          <Wrench className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            Quien despliega: el detalle completo está en{' '}
            <code className="rounded bg-slate-800 px-1">/api/salud</code> (JSON) y en la pantalla de
            diagnóstico.
          </span>
        </p>
      </div>
    </div>
  );
}
