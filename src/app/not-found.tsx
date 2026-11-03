import Link from 'next/link';
import { Compass, GraduationCap, Home } from 'lucide-react';

/**
 * La página que no existe.
 *
 * Antes, una dirección antigua (o un enlace de una base regenerada) caía en el
 * 404 en inglés de Next, sin salida. Aquí se explica en castellano y se ofrecen
 * las dos puertas que de verdad sirven: el Cuartel y los catedráticos.
 */
export default function NoEncontrada() {
  return (
    <div className="min-h-[60vh] flex items-center justify-center p-6">
      <div className="w-full max-w-lg space-y-4 rounded-3xl glass-card p-6">
        <div className="flex items-center gap-2">
          <Compass className="w-5 h-5 text-emerald-400" />
          <h1 className="text-sm font-bold uppercase tracking-wider text-slate-100 font-mono">
            Esta página no existe
          </h1>
        </div>

        <p className="text-xs text-slate-300 leading-relaxed">
          La dirección a la que has llegado no lleva a ninguna parte de la app. No se ha roto
          nada ni se ha perdido ningún dato: seguramente sea un enlace antiguo.
        </p>

        <div className="flex flex-wrap gap-2">
          <Link
            href="/"
            className="inline-flex items-center gap-2 rounded-xl bg-emerald-500 px-4 py-2.5 text-xs font-bold text-slate-950 transition-all hover:bg-emerald-400"
          >
            <Home className="w-4 h-4" />
            <span>Volver al Cuartel</span>
          </Link>

          <Link
            href="/brainup"
            className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-[#0a0a0c] px-4 py-2.5 text-xs font-semibold text-slate-200 transition-all hover:bg-[#111827]"
          >
            <GraduationCap className="w-4 h-4" />
            <span>Ver los catedráticos</span>
          </Link>
        </div>
      </div>
    </div>
  );
}
