'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { AlertTriangle, RefreshCw, Wrench } from 'lucide-react';
import { reportClientError } from '@/lib/clientErrors';

/**
 * Cuando una vista se rompe, esto es lo que se ve.
 *
 * Antes, un error de render dejaba la pantalla de error por defecto de Next (o el
 * aviso de desarrollo en rojo): desde fuera parece que «la app se ha caído» y no
 * da ninguna salida. Aquí se explica en castellano, se ofrece **reintentar** (que
 * rehace el render, y en `next dev` suele bastar tras una recompilación) y se
 * apunta el fallo con su contexto en el servidor para que el taller de
 * mantenimiento lo tenga.
 *
 * No promete que se arregle solo: dice que queda anotado y dónde mirarlo.
 */

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
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

        <p className="text-xs text-slate-300 leading-relaxed">
          El resto de la app sigue funcionando (tus datos están en la base, no se ha perdido
          nada). Lo más probable es que fuera una recompilación a medias: dale a{' '}
          <strong className="text-slate-100">Reintentar</strong>.
        </p>

        <p className="text-[11px] text-slate-500 font-mono break-words">
          {error.digest ? `referencia ${error.digest} · ` : ''}
          {error.message.slice(0, 180)}
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
            href="/"
            className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-[#0a0a0c] px-4 py-2.5 text-xs font-semibold text-slate-200 transition-all hover:bg-[#111827]"
          >
            <span>Volver al Cuartel</span>
          </Link>

          <Link
            href="/mantenimiento"
            className="inline-flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs font-semibold text-amber-300 transition-all hover:bg-amber-500/20"
          >
            <Wrench className="w-4 h-4" />
            <span>Anotarlo en el taller</span>
          </Link>
        </div>

        <p className="text-[11px] text-slate-500 leading-relaxed">
          Si vuelve a pasar, cuéntalo en <strong className="text-slate-300">/mantenimiento</strong> (qué
          estabas haciendo y qué esperabas): queda registrado con su contexto y el vigilante lo revisa en
          la siguiente pasada.
        </p>
      </div>
    </div>
  );
}
