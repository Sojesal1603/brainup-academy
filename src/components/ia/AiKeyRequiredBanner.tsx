import Link from 'next/link';
import { AlertTriangle, KeyRound } from 'lucide-react';

/** Aviso de «falta tu clave» con una salida clara, no un error genérico. */
export default function AiKeyRequiredBanner() {
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" />
        <div>
          <p className="text-sm font-bold text-amber-100">Falta tu clave de IA</p>
          <p className="mt-0.5 text-[11px] text-amber-200/80">
            Añádela en Ajustes para usar al catedrático. Se guarda cifrada y solo se usa en tus
            peticiones; la clave de la plataforma no se gasta por otras cuentas.
          </p>
        </div>
      </div>
      <Link
        href="/ajustes"
        className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-amber-400 px-3 py-2 text-xs font-bold text-slate-950 transition-colors hover:bg-amber-300"
      >
        <KeyRound className="h-4 w-4" />
        Añadir mi clave
      </Link>
    </div>
  );
}
